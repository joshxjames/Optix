// Optix marketing-site animation + scroll script.
//
// Goals:
//   - Hero text orchestrated entrance on first paint
//   - Section content reveals on viewport entry (IntersectionObserver +
//     anime.js for the actual transition)
//   - Subtle 3D tilt on mode-cards (mouse-position driven)
//   - Scroll progress bar at the very top
//   - Number counter in pricing on viewport entry
//   - Auto-hide nav on scroll-down, reveal on scroll-up
//
// All of this is purely additive — the page is fully readable + functional
// with JS off (or with prefers-reduced-motion: reduce). Animations only
// elevate, never gate content.

import { animate, stagger } from 'animejs';

// Bail out of orchestration if the user prefers reduced motion. The
// stylesheet has matching @media handling so the visual fallback already
// works; this just stops us spinning timers and observers.
const PREFERS_REDUCED =
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// ----------------------------------------------------------------------------
// Hero — orchestrate the entry sequence on first paint.
// ----------------------------------------------------------------------------

function animateHero() {
  if (PREFERS_REDUCED) return;

  // Eyebrow, then title lines (staggered), then lede, then actions. Each step
  // overlaps slightly so the whole sequence runs ~1.2s without feeling slow.
  animate('.hero__eyebrow', {
    opacity: [0, 1],
    translateY: [12, 0],
    duration: 700,
    ease: 'out(3)',
  });

  animate('.hero__title-line', {
    opacity: [0, 1],
    translateY: [28, 0],
    duration: 900,
    delay: stagger(120, { start: 200 }),
    ease: 'out(3)',
  });

  animate('.hero__lede', {
    opacity: [0, 1],
    translateY: [16, 0],
    duration: 800,
    delay: 700,
    ease: 'out(3)',
  });

  animate('.hero__actions', {
    opacity: [0, 1],
    translateY: [12, 0],
    duration: 700,
    delay: 900,
    ease: 'out(3)',
  });

  animate('.hero__scroll-hint', {
    opacity: [0, 1],
    duration: 600,
    delay: 1200,
    ease: 'out(2)',
  });
}

// ----------------------------------------------------------------------------
// Scroll-revealed elements — anything with [data-reveal].
// IntersectionObserver triggers a one-shot anime.js transition the first time
// each element enters the viewport. We add [data-revealed] as an idempotency
// flag + so CSS can match the post-reveal state for cases where JS lags.
// ----------------------------------------------------------------------------

function setupRevealOnScroll() {
  if (PREFERS_REDUCED) {
    // Mark everything as revealed up front so the styles apply.
    document.querySelectorAll('[data-reveal]').forEach((el) => {
      el.setAttribute('data-revealed', '');
    });
    return;
  }

  const els = document.querySelectorAll('[data-reveal]');
  if (els.length === 0) return;

  const io = new IntersectionObserver(
    (entries) => {
      // Group entries into a single anime.js call so siblings staggered into
      // view together animate as a coordinated batch (cheaper + more visually
      // pleasing than one-call-per-entry).
      const incoming = entries
        .filter((e) => e.isIntersecting && !e.target.hasAttribute('data-revealed'))
        .map((e) => e.target);

      if (incoming.length === 0) return;

      incoming.forEach((el) => el.setAttribute('data-revealed', ''));
      io.unobserve(...incoming.map((el) => el)); // noop on browsers; we still call below
      incoming.forEach((el) => io.unobserve(el));

      animate(incoming, {
        opacity: [0, 1],
        translateY: [28, 0],
        duration: 700,
        delay: stagger(80),
        ease: 'out(3)',
      });
    },
    {
      // Trigger when 15% of the element is in view. Keeps reveals close to
      // user attention without firing too early on tall sections.
      threshold: 0.15,
      // Pull the bottom rootMargin up a bit so we trigger as the element
      // enters from below, not after it's halfway up the viewport.
      rootMargin: '0px 0px -80px 0px',
    },
  );

  els.forEach((el) => io.observe(el));
}

// ----------------------------------------------------------------------------
// 3D tilt on mode-cards — cursor-position drives a perspective rotateX/Y.
// Cheap, no per-frame requestAnimationFrame loop; we just throttle on
// pointermove and use CSS transitions for the smoothing.
// ----------------------------------------------------------------------------

function setupCardTilt() {
  if (PREFERS_REDUCED) return;

  const MAX_TILT = 6; // degrees — subtle, not theme-park

  document.querySelectorAll('[data-tilt]').forEach((card) => {
    let raf = 0;

    card.addEventListener('pointermove', (e) => {
      if (raf) return; // throttle to once per animation frame
      raf = requestAnimationFrame(() => {
        raf = 0;
        const rect = card.getBoundingClientRect();
        // Normalize cursor position to [-1, 1] across each axis. Y inverted so
        // moving the cursor up tilts the top of the card toward the viewer.
        const px = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const py = ((e.clientY - rect.top) / rect.height) * 2 - 1;
        const rx = -py * MAX_TILT;
        const ry = px * MAX_TILT;
        card.style.transform = `perspective(1000px) rotateX(${rx}deg) rotateY(${ry}deg) translateZ(0)`;
      });
    });

    card.addEventListener('pointerleave', () => {
      // Rest position. The CSS transition (set on .mode-card) interpolates
      // back to identity smoothly.
      card.style.transform = '';
    });
  });
}

// ----------------------------------------------------------------------------
// Scroll progress bar — top-of-viewport sliver showing how far down the
// document the user is. Cheap math, runs on scroll with passive listener.
// ----------------------------------------------------------------------------

function setupScrollProgress() {
  const bar = document.querySelector('.scroll-progress');
  if (!bar) return;

  const update = () => {
    const scrollMax = document.documentElement.scrollHeight - window.innerHeight;
    const pct = scrollMax > 0 ? (window.scrollY / scrollMax) * 100 : 0;
    bar.style.width = `${pct}%`;
  };

  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
}

// ----------------------------------------------------------------------------
// Auto-hide nav — slide it up when the user scrolls down past the hero,
// reveal it again when they scroll up. Avoids the nav covering page chrome.
// ----------------------------------------------------------------------------

function setupAutoHideNav() {
  const nav = document.querySelector('[data-nav]');
  if (!nav) return;

  let lastY = window.scrollY;
  let raf = 0;

  const update = () => {
    raf = 0;
    const y = window.scrollY;
    const goingDown = y > lastY;
    // Don't hide while still inside the hero (gives the nav a chance to be
    // visible on first impression). 60vh is a heuristic that maps to "you've
    // scrolled past the meaningful hero copy".
    const heroEnd = window.innerHeight * 0.6;

    if (goingDown && y > heroEnd) {
      nav.setAttribute('data-hidden', '');
    } else {
      nav.removeAttribute('data-hidden');
    }
    lastY = y;
  };

  window.addEventListener(
    'scroll',
    () => {
      if (raf) return;
      raf = requestAnimationFrame(update);
    },
    { passive: true },
  );
}

// ----------------------------------------------------------------------------
// Pricing counters — animate from 0 → target on viewport entry.
// ----------------------------------------------------------------------------

function setupPriceCounters() {
  const counters = document.querySelectorAll('[data-counter]');
  if (counters.length === 0) return;

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        if (el.hasAttribute('data-counted')) return;
        el.setAttribute('data-counted', '');
        io.unobserve(el);

        const target = parseInt(el.getAttribute('data-counter') ?? '0', 10);
        if (PREFERS_REDUCED) {
          el.textContent = String(target);
          return;
        }

        // anime.js v4 utils.set + a manual interpolation timer is overkill
        // for a single number; just tween via animate() with onUpdate writing
        // the rounded value into textContent.
        const state = { val: 0 };
        animate(state, {
          val: target,
          duration: 900,
          ease: 'out(2)',
          onUpdate: () => {
            el.textContent = String(Math.round(state.val));
          },
        });
      });
    },
    { threshold: 0.4 },
  );

  counters.forEach((el) => io.observe(el));
}

// ----------------------------------------------------------------------------
// Video autoplay — Safari + a few other browsers refuse to autoplay videos
// with sound or in low-power mode. We listen for the failure and quietly
// fall back to a static frame (already in the poster attribute).
// ----------------------------------------------------------------------------

function setupHeroVideoFallback() {
  const video = document.querySelector('.hero__video');
  if (!video) return;

  // playsinline, muted, autoplay should cover most browsers. If the play
  // promise rejects (Low Power, restrictive UA), we just leave the poster
  // visible. Don't surface an error.
  const promise = video.play();
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => {
      // Hide the broken-state video element so the dark gradient stands alone.
      video.style.display = 'none';
    });
  }
}

// ----------------------------------------------------------------------------
// Boot — wire it all up after DOMContentLoaded so we don't race the layout.
// ----------------------------------------------------------------------------

function boot() {
  setupHeroVideoFallback();
  animateHero();
  setupRevealOnScroll();
  setupCardTilt();
  setupScrollProgress();
  setupAutoHideNav();
  setupPriceCounters();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
