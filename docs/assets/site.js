// Cosplay CMS profile site — the only interactivity is the install-method
// switcher in the quick start section. Everything else is static HTML, so the
// page works with JavaScript disabled; the two code blocks are both in the
// markup and the second is only hidden by the `hidden` attribute.
(function () {
  'use strict';

  var tabs = Array.prototype.slice.call(document.querySelectorAll('.code-tab'));
  var blocks = Array.prototype.slice.call(document.querySelectorAll('.code-block'));
  if (!tabs.length) return;

  function select(mode) {
    tabs.forEach(function (tab) {
      var on = tab.dataset.mode === mode;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
      // Roving tabindex: only the selected tab is reachable with Tab, so the
      // group is one stop rather than two. Without this the markup's initial
      // state would be the only correct one and a click would desync it.
      tab.setAttribute('tabindex', on ? '0' : '-1');
    });
    blocks.forEach(function (block) {
      block.hidden = block.dataset.mode !== mode;
    });
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () { select(tab.dataset.mode); });
  });

  // Arrow-key navigation between the tabs, per the WAI-ARIA tabs pattern.
  tabs.forEach(function (tab, i) {
    tab.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      if (!next) return;
      e.preventDefault();
      next.focus();
      select(next.dataset.mode);
    });
  });
})();
