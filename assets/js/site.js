/* Fed Advisor Solutions — site behaviour
   Vanilla JS, no dependencies, no build step. */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- nav */
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('primary-nav');

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* Mark the current page in the nav */
  var here = location.pathname.split('/').pop() || 'index.html';
  Array.prototype.forEach.call(
    document.querySelectorAll('.nav__link'),
    function (link) {
      var target = link.getAttribute('href');
      if (target === here || (here === 'index.html' && target === '/')) {
        link.setAttribute('aria-current', 'page');
      }
    }
  );

  /* ------------------------------------------------------------- reveal */
  var revealables = document.querySelectorAll('.reveal');
  if (revealables.length) {
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add('is-in');
              io.unobserve(entry.target);
            }
          });
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
      );
      Array.prototype.forEach.call(revealables, function (el) {
        io.observe(el);
      });
    } else {
      Array.prototype.forEach.call(revealables, function (el) {
        el.classList.add('is-in');
      });
    }
  }

  /* -------------------------------------------------------- chart bars */
  /* Bars start at height 0 and grow to their data-height when scrolled in. */
  var bars = document.querySelectorAll('.bar__fill[data-height]');
  if (bars.length) {
    var grow = function (el) {
      el.style.height = el.getAttribute('data-height');
    };
    if ('IntersectionObserver' in window) {
      var barIo = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              grow(entry.target);
              barIo.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.25 }
      );
      Array.prototype.forEach.call(bars, function (el) {
        el.style.height = '0%';
        barIo.observe(el);
      });
    } else {
      Array.prototype.forEach.call(bars, grow);
    }
  }

  /* ---------------------------------------------------------- the form */
  var form = document.getElementById('apply-form');
  if (!form) return;

  var status = document.getElementById('form-status');
  var submit = form.querySelector('button[type="submit"]');
  var submitLabel = submit ? submit.textContent : '';

  function say(message, kind) {
    if (!status) return;
    status.textContent = message;
    status.className = 'form-status is-visible form-status--' + kind;
    status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    var data = {};
    new FormData(form).forEach(function (value, key) {
      data[key] = typeof value === 'string' ? value.trim() : value;
    });
    data.page = location.pathname;
    data.submittedAt = new Date().toISOString();

    if (submit) {
      submit.disabled = true;
      submit.textContent = 'Sending…';
    }
    say('Sending your application…', 'ok');

    fetch('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(result.body && result.body.error ? result.body.error : 'Request failed');
        }
        form.reset();
        window.location.href = 'thank-you.html';
      })
      .catch(function (err) {
        console.error('[apply]', err);
        say(
          'Something went wrong sending your application. Please email ' +
            'partners@fedadvisorsolutions.com and we will pick it up from there.',
          'error'
        );
        if (submit) {
          submit.disabled = false;
          submit.textContent = submitLabel;
        }
      });
  });
})();
