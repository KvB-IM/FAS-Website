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

  /* Meta Pixel. Guarded because the pixel is blocked by most ad blockers and
     by anyone browsing privately — tracking must never be able to stop a form
     from submitting.

     Nothing identifying is ever passed. The form collects a name, email, and
     phone number; Meta's terms prohibit sending those as event parameters, so
     only the page and form name go out. */
  function track(event, isCustom) {
    try {
      if (typeof window.fbq !== 'function') return;
      window.fbq(isCustom ? 'trackCustom' : 'track', event, {
        content_name: 'Partner Agent Application',
        content_category: 'partner-application',
        source_page: location.pathname
      });
    } catch (err) {
      /* never let analytics break the form */
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    // Every press of the button, including ones the browser then rejects for a
    // missing required field. Counting these separately from Lead is what makes
    // an abandonment rate visible.
    track('ApplicationSubmitClicked', true);

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

        // The conversion that matters — fired only once the API has actually
        // accepted the application, so it counts leads rather than button
        // presses. This is the event to optimise ad delivery against.
        track('Lead');

        // The pixel sends asynchronously and navigating away can cancel a
        // request that hasn't left yet, so give it a moment before the
        // redirect. Guarded by `done` so a slow or blocked pixel can never
        // strand someone on the form.
        var done = false;
        var go = function () {
          if (done) return;
          done = true;
          window.location.href = 'thank-you.html';
        };
        setTimeout(go, 300);
      })
      .catch(function (err) {
        console.error('[apply]', err);
        say(
          'Something went wrong sending your application. Please email ' +
            'contact@fedadvisorsolutions.com and we will pick it up from there.',
          'error'
        );
        if (submit) {
          submit.disabled = false;
          submit.textContent = submitLabel;
        }
      });
  });
})();
