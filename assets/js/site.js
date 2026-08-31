/* Fed Advisor Solutions — site behaviour.
   The concept's app.js, minus the light/dark toggle, plus the application
   form. Vanilla JS, no dependencies, no build step. */
(function () {
  "use strict";

  /* ------------------------------------------------------------ mobile nav */
  const menuButton = document.querySelector("[data-menu-toggle]");
  const menu = document.querySelector("[data-nav-links]");

  menuButton?.addEventListener("click", () => {
    const isOpen = menu.classList.toggle("is-open");
    menuButton.setAttribute("aria-expanded", String(isOpen));
  });

  menu?.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      menu.classList.remove("is-open");
      menuButton?.setAttribute("aria-expanded", "false");
    });
  });

  /* --------------------------------------------------------------- reveals */
  const revealables = document.querySelectorAll(".reveal");
  if (revealables.length) {
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible");
              observer.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.14 }
      );
      revealables.forEach((element) => observer.observe(element));
    } else {
      revealables.forEach((element) => element.classList.add("is-visible"));
    }
  }

  /* ------------------------------------------------------------------- FAQ */
  document.querySelectorAll(".faq-question").forEach((button) => {
    button.addEventListener("click", () => {
      const item = button.closest(".faq-item");
      const wasOpen = item.classList.contains("is-open");
      document.querySelectorAll(".faq-item").forEach((faq) => {
        faq.classList.remove("is-open");
        faq.querySelector(".faq-question")?.setAttribute("aria-expanded", "false");
      });
      if (!wasOpen) {
        item.classList.add("is-open");
        button.setAttribute("aria-expanded", "true");
      }
    });
  });

  /* ------------------------------------------------------- application form */
  const form = document.getElementById("apply-form");
  if (!form) return;

  const status = document.getElementById("form-status");
  const submit = form.querySelector('button[type="submit"]');
  const submitLabel = submit ? submit.textContent : "";

  function say(message, kind) {
    if (!status) return;
    status.textContent = message;
    status.className = "form-status is-visible form-status--" + kind;
    status.setAttribute("role", kind === "error" ? "alert" : "status");
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const data = {};
    new FormData(form).forEach((value, key) => {
      data[key] = typeof value === "string" ? value.trim() : value;
    });
    data.page = location.pathname;
    data.submittedAt = new Date().toISOString();

    if (submit) {
      submit.disabled = true;
      submit.textContent = "Sending…";
    }
    say("Sending your application…", "ok");

    fetch("/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.body?.error || "Request failed");
        }
        form.reset();
        window.location.href = "thank-you.html";
      })
      .catch((err) => {
        console.error("[apply]", err);
        say(
          "Something went wrong sending your application. Please call 803-220-3991 " +
            "or email contact@fedadvisorsolutions.com and we will pick it up from there.",
          "error"
        );
        if (submit) {
          submit.disabled = false;
          submit.textContent = submitLabel;
        }
      });
  });
})();
