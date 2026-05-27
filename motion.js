// Fast Track — shared motion helpers
(function () {
  'use strict';

  // ---------- Scroll-triggered reveals ----------
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        observer.unobserve(e.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -50px 0px' });

  function observeReveals() {
    document.querySelectorAll('.reveal:not(.visible)').forEach(el => observer.observe(el));
  }
  document.addEventListener('DOMContentLoaded', observeReveals);
  // Re-observe after dynamic content changes
  window.ftObserveReveals = observeReveals;

  // ---------- Auto-tag common sections as reveals ----------
  document.addEventListener('DOMContentLoaded', () => {
    const candidates = document.querySelectorAll(
      '.steps .step, .product-grid .product, .schools-grid .school-card, .kits-grid .kit-card, .promise-grid .promise-item, .trust-grid .trust-item'
    );
    candidates.forEach((el, i) => {
      el.classList.add('reveal');
      el.dataset.delay = String(((i % 4) * 100) || 0);
      observer.observe(el);
    });
  });

  // ---------- Cart count bump animation ----------
  window.ftBumpCart = function () {
    const el = document.getElementById('cart-count');
    if (!el) return;
    el.classList.remove('bump');
    void el.offsetWidth;  // restart animation
    el.classList.add('bump');
  };

  // ---------- Swap text wordmarks for the real logo image ----------
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.wordmark').forEach(el => {
      el.setAttribute('aria-label', 'Fast Track School Supplies');
      // Tag context so we can style header vs footer differently
      const isFooter = el.closest('footer') !== null;
      el.innerHTML = `<img src="/assets/logo.png" alt="Fast Track School Supplies" class="brand-logo${isFooter ? ' brand-logo-footer' : ''}" />`;
    });
  });

  // ---------- Mobile menu (hamburger) ----------
  document.addEventListener('DOMContentLoaded', () => {
    const navLinks = document.querySelector('header .nav-links');
    const navContainer = document.querySelector('header .nav');
    if (!navLinks || !navContainer) return;

    // Clone the nav links into a mobile menu drawer
    const mobileMenu = document.createElement('div');
    mobileMenu.className = 'mobile-menu';
    mobileMenu.innerHTML = `
      <button class="mobile-menu-close" aria-label="Close menu">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      ${navLinks.innerHTML}
    `;
    const overlay = document.createElement('div');
    overlay.className = 'mobile-menu-overlay';

    // Add a hamburger button next to (or before) the cart button in the header
    const hamburger = document.createElement('button');
    hamburger.className = 'mobile-menu-btn';
    hamburger.setAttribute('aria-label', 'Open menu');
    hamburger.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;

    // Insert hamburger as the LAST child of nav (visible on mobile only via CSS)
    navContainer.appendChild(hamburger);
    document.body.appendChild(mobileMenu);
    document.body.appendChild(overlay);

    const open = () => { mobileMenu.classList.add('open'); overlay.classList.add('open'); document.body.style.overflow = 'hidden'; };
    const close = () => { mobileMenu.classList.remove('open'); overlay.classList.remove('open'); document.body.style.overflow = ''; };
    hamburger.addEventListener('click', open);
    overlay.addEventListener('click', close);
    mobileMenu.querySelector('.mobile-menu-close').addEventListener('click', close);
    mobileMenu.querySelectorAll('a').forEach(a => a.addEventListener('click', close));
  });
})();
