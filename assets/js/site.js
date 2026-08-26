/* Fed Advisor Solutions — site behaviour.
   Vanilla JS, no dependencies, no build step. */
(function () {
  'use strict';

  /* ------------------------------------------------------------ mobile nav */
  var menuButton = document.querySelector('[data-menu-toggle]');
  var menu = document.querySelector('[data-nav-links]');

  if (menuButton && menu) {
    menuButton.addEventListener('click', function () {
      var open = menu.classList.toggle('is-open');
      menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        menu.classList.remove('is-open');
        menuButton.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* --------------------------------------------------------------- reveals */
  var revealables = document.querySelectorAll('.reveal');
  if (revealables.length) {
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add('is-visible');
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
        el.classList.add('is-visible');
      });
    }
  }

  /* ------------------------------------------------------------------- FAQ */
  Array.prototype.forEach.call(
    document.querySelectorAll('.faq-question'),
    function (button) {
      button.addEventListener('click', function () {
        var item = button.closest('.faq-item');
        var wasOpen = item.classList.contains('is-open');

        Array.prototype.forEach.call(
          document.querySelectorAll('.faq-item'),
          function (faq) {
            faq.classList.remove('is-open');
            var q = faq.querySelector('.faq-question');
            if (q) q.setAttribute('aria-expanded', 'false');
          }
        );

        if (!wasOpen) {
          item.classList.add('is-open');
          button.setAttribute('aria-expanded', 'true');
        }
      });
    }
  );

  /* ------------------------------------------------------------------ form */
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
          throw new Error(
            result.body && result.body.error ? result.body.error : 'Request failed'
          );
        }
        form.reset();
        window.location.href = 'thank-you.html';
      })
      .catch(function (err) {
        console.error('[apply]', err);
        say(
          'Something went wrong sending your application. Please call 706-407-2744 ' +
            'or email partners@fedadvisorsolutions.com and we will pick it up from there.',
          'error'
        );
        if (submit) {
          submit.disabled = false;
          submit.textContent = submitLabel;
        }
      });
  });
})();
