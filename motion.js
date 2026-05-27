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
})();
