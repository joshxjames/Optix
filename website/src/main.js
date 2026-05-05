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

// `?url` makes Vite emit the file as a hashed asset and return its
// public URL string. This is what gives us `dist/assets/hero-[hash].mp4`
// (immutable-cacheable forever) without a `<source>` tag in the HTML
// that would trigger eager fetching on parse.
import heroVideoUrl from '../assets/hero.mp4?url';

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
// Hero typewriter — rotates through the verb list. Pure JS state machine
// (typing → holding → erasing → next word → loop). anime.js is overkill
// for character-by-character text manipulation; setTimeout chaining gives
// finer control over the per-phase timing.
//
// Kicks in AFTER the hero entry sequence has settled so the user gets a
// clean read of the title before the rotation starts.
// ----------------------------------------------------------------------------

// Words include the trailing period so it gets typed + erased with each
// cycle. The period is rendered into a separate span so it can stay white
// while the verb stays cyan — see render() below.
const TYPEWRITER_WORDS = ['sees.', 'answers.', 'acts.', 'automates.'];
const TYPEWRITER_TIMING = {
  type: 90,         // ms per char while typing
  erase: 45,        // ms per char while erasing (snappier than typing)
  hold: 1600,       // ms to display fully-typed word
  pause: 220,       // ms between erasing one word and typing the next
  startDelay: 1800, // ms after page load before the first cycle begins
};

function setupHeroTypewriter() {
  const verbEl = document.querySelector('.hero__typewriter-verb');
  const dotEl = document.querySelector('.hero__typewriter-dot');
  if (!verbEl || !dotEl) return;

  // prefers-reduced-motion users get a static word; cycle is purely
  // decorative so we drop it without UX loss.
  if (PREFERS_REDUCED) return;

  /** Render a partially-typed string across the two spans. The verb part
   *  goes to the cyan span; the trailing period (if present) goes to the
   *  white span. Splitting like this keeps the colors decoupled while
   *  the timing still treats the dot as character N+1 of each word. */
  function render(typed) {
    if (typed.endsWith('.')) {
      verbEl.textContent = typed.slice(0, -1);
      dotEl.textContent = '.';
    } else {
      verbEl.textContent = typed;
      dotEl.textContent = '';
    }
  }

  // Start state derived from the SSR markup: whichever word is fully
  // rendered (verb + dot combined). Falls back to first word on mismatch.
  const initial = (verbEl.textContent ?? '') + (dotEl.textContent ?? '');
  let wordIndex = TYPEWRITER_WORDS.indexOf(initial.trim());
  if (wordIndex === -1) wordIndex = 0;
  let charIndex = initial.length;

  // States: 'hold' (fully typed, waiting), 'erase' (deleting chars),
  // 'type' (adding chars). Start in 'hold' to give the user a beat
  // with the original word visible before the rotation kicks in.
  let phase = 'hold';

  function tick() {
    const word = TYPEWRITER_WORDS[wordIndex];
    if (!word) return; // safety — array somehow empty

    if (phase === 'hold') {
      phase = 'erase';
      setTimeout(tick, TYPEWRITER_TIMING.hold);
      return;
    }

    if (phase === 'erase') {
      charIndex = Math.max(0, charIndex - 1);
      render(word.slice(0, charIndex));
      if (charIndex === 0) {
        // Move to the next word + start typing.
        wordIndex = (wordIndex + 1) % TYPEWRITER_WORDS.length;
        phase = 'type';
        setTimeout(tick, TYPEWRITER_TIMING.pause);
        return;
      }
      setTimeout(tick, TYPEWRITER_TIMING.erase);
      return;
    }

    if (phase === 'type') {
      const next = TYPEWRITER_WORDS[wordIndex];
      if (!next) return;
      charIndex = Math.min(next.length, charIndex + 1);
      render(next.slice(0, charIndex));
      if (charIndex === next.length) {
        phase = 'hold';
        setTimeout(tick, 0);
        return;
      }
      setTimeout(tick, TYPEWRITER_TIMING.type);
    }
  }

  // Kick off after the hero entry settles. The full hero stagger ends
  // around 1.5s (eyebrow → 3 title lines → lede → CTAs → scroll hint);
  // 1.8s gives a half-beat of stillness before the cycle starts.
  setTimeout(tick, TYPEWRITER_TIMING.startDelay);
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
// "How it works" scrollytelling — observe the 3 invisible trigger blocks
// inside the section's scroll track and flip [data-phase] on the section
// root as each one crosses the middle of the viewport. The CSS handles
// the crossfade between layered scenes (graphic) + panels (text).
//
// rootMargin: '-50% 0px -50% 0px' narrows the active zone to a 0px-tall
// horizontal slice at the dead-center of the viewport. A trigger block
// "fires" when its top edge crosses below center AND its bottom edge is
// still above — i.e., the user is currently in the middle of that
// trigger's 100vh range. This gives crisp phase changes at predictable
// scroll positions.
// ----------------------------------------------------------------------------

function setupHowScrollytelling() {
  const section = document.querySelector('#how');
  if (!section) return;
  const triggers = section.querySelectorAll('.how__trigger');
  if (triggers.length === 0) return;

  // Tabs at the top of the mock window — visual state is fully driven by
  // [data-phase] in CSS (so the IO below remains the single source of
  // truth). Click handler is the only JS the tabs need: it scrolls so
  // the matching trigger lands at viewport center, which causes the IO
  // to fire and the data-phase + active-tab styling to update.
  const tabs = section.querySelectorAll('.how__tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const phase = tab.getAttribute('data-tab');
      if (!phase) return;
      const target = section.querySelector(
        `.how__trigger[data-how-phase="${phase}"]`,
      );
      if (!target) return;
      // Trigger blocks are 100vh tall; scrolling so their CENTRE is at
      // viewport centre is exactly what fires the IO at the rootMargin
      // we set below ("-50% 0px -50% 0px"). The math is the same as
      // `scrollIntoView({ block: 'center' })` but explicit so we can
      // honour reduced-motion preference.
      const rect = target.getBoundingClientRect();
      const top =
        window.scrollY + rect.top + rect.height / 2 - window.innerHeight / 2;
      window.scrollTo({
        top,
        behavior: PREFERS_REDUCED ? 'auto' : 'smooth',
      });
    });
  });

  // On reduced-motion / mobile-collapsed layout, the triggers are hidden
  // (display: none via the @media query). The observer would still fire
  // but with all triggers off-screen, the result is no-op. Bail early
  // either way — saves a microtask per scroll event.
  if (PREFERS_REDUCED) return;

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const phase = entry.target.getAttribute('data-how-phase');
        if (phase) section.setAttribute('data-phase', phase);
      });
    },
    {
      // Active zone: the dead center of the viewport. A trigger block
      // intersects this 0px-tall slice when its middle is in the viewport
      // middle, giving a clean phase boundary at every 100vh of scroll.
      rootMargin: '-50% 0px -50% 0px',
      threshold: 0,
    },
  );

  triggers.forEach((t) => io.observe(t));
}

// ----------------------------------------------------------------------------
// Section-background reveals — sections marked [data-bg-reveal] paint
// their gradient via ::before with opacity:0; this observer adds
// [data-bg-revealed] when the section enters the viewport so the bg
// fades in alongside the cards (instead of being painted statically
// before the user has scrolled to that section's content).
// ----------------------------------------------------------------------------

function setupSectionBgReveal() {
  const sections = document.querySelectorAll('[data-bg-reveal]');
  if (sections.length === 0) return;

  if (PREFERS_REDUCED) {
    // Skip the fade — show bg immediately so the visual still works.
    sections.forEach((s) => s.setAttribute('data-bg-revealed', ''));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        if (entry.target.hasAttribute('data-bg-revealed')) return;
        entry.target.setAttribute('data-bg-revealed', '');
        io.unobserve(entry.target);
      });
    },
    {
      // Fire fairly early so the bg has time to finish its 1s fade
      // before the user is fully in the section. Smaller threshold +
      // negative bottom rootMargin = "the section is just starting to
      // come into view from the bottom".
      threshold: 0.05,
      rootMargin: '0px 0px -120px 0px',
    },
  );

  sections.forEach((s) => io.observe(s));
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
// Hero video — lazy-mount with Save-Data / slow-connection bypass.
//
// The <video> element ships WITHOUT a <source> child. We attach the
// source dynamically only when:
//   1. The user isn't on data-saver mode (`navigator.connection.saveData`)
//   2. The connection effective type is faster than 2g
//   3. The hero is in or near the viewport (IntersectionObserver)
//   4. The user hasn't requested reduced motion
//
// Users who fail those checks see the poster only — they never trigger
// the video download, which is the largest bandwidth lever on the page.
// On Firebase Hosting at $0.15/GB egress, a typical bouncing-mobile
// visitor would have cost the same as an engaged desktop visitor; this
// gate stops that cost from being incurred at all.
//
// Autoplay quirks: even with the source mounted, Safari Low Power and
// some restrictive UAs will reject the play() promise. We catch and
// hide the element so the poster + dark gradient stand alone.
// ----------------------------------------------------------------------------

function setupHeroVideo() {
  const video = document.querySelector('.hero__video');
  if (!video) return;

  // Hashed URL injected by Vite's `?url` import. Empty string would
  // mean the asset import failed at build — bail rather than mount a
  // broken source.
  const src = heroVideoUrl;
  const type = 'video/mp4';
  if (!src) return;

  // ---- Bypass conditions: don't even fetch the file --------------------
  // navigator.connection is only on Chromium-based browsers. Treat
  // missing as "fast connection" — we don't want to penalise Safari /
  // Firefox users who happen to lack the API.
  const conn = navigator.connection ?? navigator.webkitConnection ?? null;
  const saveData = conn?.saveData === true;
  const slowConnection =
    conn?.effectiveType === 'slow-2g' || conn?.effectiveType === '2g';
  const reducedMotion =
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  if (saveData || slowConnection || reducedMotion) {
    // Leave the poster up. Nothing to mount, nothing to play.
    return;
  }

  // ---- Lazy-mount via IntersectionObserver -----------------------------
  // Hero is above the fold so this nearly always fires immediately, but
  // the observer also catches edge cases (deeplinks to mid-page anchors,
  // browsers that race the JS init before layout).
  const mount = () => {
    if (video.dataset.mounted === '1') return;
    video.dataset.mounted = '1';

    const source = document.createElement('source');
    source.src = src;
    source.type = type;
    video.appendChild(source);
    video.load();

    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {
        // Restrictive UA (Safari Low Power, some embedded browsers).
        // Hide the busted video, keep the dark gradient.
        video.style.display = 'none';
      });
    }
  };

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries, observer) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            mount();
            observer.disconnect();
            return;
          }
        }
      },
      { rootMargin: '200px' }, // start fetching slightly before in-view
    );
    io.observe(video);
  } else {
    // Fallback for ancient browsers — just mount synchronously.
    mount();
  }
}

// ----------------------------------------------------------------------------
// Boot — wire it all up after DOMContentLoaded so we don't race the layout.
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Contact modal — opened by [data-open-contact] buttons, closed by
// [data-close-contact], the backdrop, or Escape. Form submits to the
// existing `submitFeedback` Cloud Function (same endpoint the desktop
// widget posts to) so support emails land in the same inbox.
//
// Honeypot: an off-screen "website" input that human users never see
// or fill. Bots that auto-fill every field will populate it; the JS
// silent-rejects any submission with a non-empty honeypot. The Cloud
// Function does the same check server-side as defense-in-depth.
// ----------------------------------------------------------------------------

const SUBMIT_FEEDBACK_URL =
  'https://us-central1-optix-22473.cloudfunctions.net/submitFeedback';
const SUBMIT_TIMEOUT_MS = 15_000;

function setupContactModal() {
  const modal = document.querySelector('[data-contact-modal]');
  if (!modal) return;

  const form = modal.querySelector('[data-contact-form]');
  const errorEl = modal.querySelector('[data-form-error]');
  const submitBtn = modal.querySelector('[data-submit-button]');
  const sentState = modal.querySelector('[data-sent-state]');
  const honeypot = modal.querySelector('[data-honeypot]');
  const counter = modal.querySelector('[data-counter]');
  const messageInput = modal.querySelector('textarea[name="message"]');
  const closeButtons = modal.querySelectorAll('[data-close-contact]');
  const openButtons = document.querySelectorAll('[data-open-contact]');

  if (!form || !errorEl || !submitBtn || !sentState || !honeypot) return;

  let lastFocusedBeforeOpen = null;

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function hideError() {
    errorEl.textContent = '';
    errorEl.hidden = true;
  }

  function openModal() {
    lastFocusedBeforeOpen = document.activeElement;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('contact-modal-open');
    // Defer focus until after the modal paints so the focus ring lands
    // cleanly on the first input rather than flashing into the close
    // button on render.
    requestAnimationFrame(() => {
      const firstInput = form.querySelector('input[name="email"]');
      if (firstInput instanceof HTMLElement) firstInput.focus();
    });
  }

  function closeModal() {
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('contact-modal-open');
    hideError();
    // Restore focus to whatever opened the modal so keyboard users
    // don't lose their place in the page.
    if (lastFocusedBeforeOpen instanceof HTMLElement) {
      lastFocusedBeforeOpen.focus();
    }
  }

  // Reset to the form view (used after a "Send another" or after a
  // sent → close → reopen cycle).
  function resetToForm() {
    form.hidden = false;
    sentState.hidden = true;
    form.reset();
    if (counter) counter.textContent = '0 / 4000';
    hideError();
  }

  // Wire up open / close triggers.
  openButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      resetToForm();
      openModal();
    });
  });
  closeButtons.forEach((btn) => {
    btn.addEventListener('click', closeModal);
  });

  // Escape closes the modal when it's open. Single document-level
  // listener (not toggled on open/close) is simpler and the cost is
  // negligible — one keydown branch per event.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  // Live character counter on the message field.
  if (messageInput && counter) {
    messageInput.addEventListener('input', () => {
      counter.textContent = `${messageInput.value.length} / 4000`;
    });
  }

  // Form submission.
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    // Honeypot check — silent reject. Don't surface an error or any
    // signal that we noticed; bots get the same UX as a successful
    // submit so they don't adapt.
    if (honeypot.value && honeypot.value.length > 0) {
      // Pretend it worked so bots don't retry with different field names.
      form.hidden = true;
      sentState.hidden = false;
      return;
    }

    const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim();
    const email = String(data.get('email') ?? '').trim();
    const category = String(data.get('category') ?? 'Question');
    const subject = String(data.get('subject') ?? '').trim();
    const message = String(data.get('message') ?? '').trim();

    // Client-side validation (HTML required attrs catch most of this,
    // but novalidate disables the browser bubbles so we surface our
    // own message in a consistent tone of voice).
    if (!email || !email.includes('@')) {
      showError('Please enter a valid email address.');
      return;
    }
    if (!subject) {
      showError('Please add a subject.');
      return;
    }
    if (!message) {
      showError('Please write a message.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);

    try {
      const res = await fetch(SUBMIT_FEEDBACK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          name,
          email,
          category,
          subject,
          message,
          // Honeypot is included in the payload so the Cloud Function
          // can also reject server-side. Most of the time this is empty
          // (real submissions) and the CF treats absence + empty string
          // identically. See submitFeedback.ts in the Optix-Cloud repo.
          honeypot: honeypot.value || '',
          diagnostics: {
            appVersion: 'website',
            userAgent: navigator.userAgent.slice(0, 500),
            locale: navigator.language,
            submittedAt: new Date().toISOString(),
          },
        }),
      });

      if (!res.ok) {
        if (res.status === 429) {
          showError('Too many submissions. Please wait a few minutes and try again.');
        } else {
          showError("Something went wrong. Please try again, or email support@covetable.com.au directly.");
        }
        return;
      }

      // Success — swap to the sent state.
      form.hidden = true;
      sentState.hidden = false;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        showError('Submission timed out. Please check your connection and try again.');
      } else {
        showError("Couldn't reach the server. Please try again, or email support@covetable.com.au directly.");
      }
    } finally {
      clearTimeout(timer);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send message';
    }
  });
}

function boot() {
  setupHeroVideo();
  animateHero();
  setupHeroTypewriter();
  setupSectionBgReveal();
  setupHowScrollytelling();
  setupRevealOnScroll();
  setupCardTilt();
  setupScrollProgress();
  setupAutoHideNav();
  setupPriceCounters();
  setupContactModal();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
