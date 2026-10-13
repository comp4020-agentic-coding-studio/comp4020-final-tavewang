// Real-time updates for MoveOut (crit 9). One file, no framework, no build
// step — it's included with a plain <script src="/live.js" data-live="...">
// on every page that wants it (src/views/moveout-public.ts,
// moveout-manage.ts, home.ts). Without this file the app still fully works:
// every form here is a real <form method=post>, so with JavaScript off (or
// this script failing to load) a person still gets the pre-crit-9 app —
// submit, then the next page reflects it.
//
// The approach, in order:
//  1. An EventSource tells this tab "something on this page changed" — it
//     carries no data (src/live.ts), so it needs no permission check of its
//     own.
//  2. On that signal, re-fetch this exact page (same URL, same cookies), the
//     same way a manual reload would — which means it's automatically
//     filtered to what *this* viewer is allowed to see, by the same route
//     handler and ownership checks as every other request.
//  3. Diff the fetched HTML against the live DOM by stable
//     data-item-id/data-application-id/data-moveout-id keys, and patch only
//     what changed — skipping (but still badge-patching) anything the
//     person is presently mid-edit on, so another person's update can't
//     clear a half-filled form out from under them.
//
// shortcut: step 2 re-fetches the whole page rather than a dedicated JSON
// delta endpoint. Simple, reuses every existing permission check verbatim,
// and fine at this app's size; upgrade to a scoped endpoint if pages grow
// large enough that a full re-fetch every sync is wasteful.
(function () {
  const scriptEl = document.currentScript;
  const eventsUrl = scriptEl && scriptEl.getAttribute("data-live");
  if (!eventsUrl) return;

  const statusEl = document.getElementById("connection-status");

  function setStatus(text, state) {
    if (!statusEl) return;
    statusEl.hidden = false;
    statusEl.textContent = text;
    statusEl.setAttribute("data-state", state);
  }

  // ---- IME composition: never touch the DOM mid-keystroke -----------------
  let composing = false;
  let requeueAfterComposition = false;
  document.addEventListener("compositionstart", () => {
    composing = true;
  });
  document.addEventListener("compositionend", () => {
    composing = false;
    if (requeueAfterComposition) {
      requeueAfterComposition = false;
      resync();
    }
  });

  // ---- SSE connection, with our own backoff (not the browser's default) --
  let es = null;
  let reconnectTimer = null;
  let backoff = 1000;
  const MAX_BACKOFF = 15000;

  function closeStream() {
    if (es) {
      es.onopen = es.onerror = null;
      es.close();
      es = null;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    setStatus("Reconnecting — information may be out of date", "reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  }

  function connect() {
    closeStream();
    es = new EventSource(eventsUrl);
    es.addEventListener("open", () => {
      backoff = 1000;
      resync();
    });
    es.addEventListener("sync", () => resync());
    es.addEventListener("error", () => {
      closeStream();
      scheduleReconnect();
    });
  }

  // ---- Resync: re-fetch this page, reconcile the DOM ----------------------
  let syncToken = 0;
  let syncFailures = 0;
  let syncRetryTimer = null;

  async function resync() {
    const token = ++syncToken;
    if (syncRetryTimer) {
      clearTimeout(syncRetryTimer);
      syncRetryTimer = null;
    }
    let text;
    try {
      const res = await fetch(location.href, { credentials: "same-origin", cache: "no-store" });
      if (token !== syncToken) return; // a newer sync superseded this one
      if (!res.ok) throw new Error("status " + res.status);
      text = await res.text();
    } catch {
      if (token !== syncToken) return;
      syncFailures++;
      setStatus("Could not sync — retrying", "error");
      const delay = Math.min(1000 * 2 ** (syncFailures - 1), MAX_BACKOFF);
      syncRetryTimer = setTimeout(resync, delay);
      return;
    }
    if (token !== syncToken) return;
    syncFailures = 0;
    if (composing) {
      requeueAfterComposition = true;
      return;
    }
    try {
      lastDoc = new DOMParser().parseFromString(text, "text/html");
      reconcile(lastDoc);
    } finally {
      setStatus("Live", "live");
    }
  }

  // The most recently fetched page, kept so a *local* event (closing a
  // <details>, a field losing focus) can re-run reconciliation against data
  // we already have — without waiting on another SSE push that may not come
  // for a while (or ever, if nobody else touches this page again). This is
  // what applies a structural update that arrived while something here was
  // protected, the moment it stops being protected, rather than leaving it
  // stale until the next unrelated business event happens to fire a resync.
  let lastDoc = null;
  let catchUpQueued = false;
  function scheduleCatchUp() {
    if (catchUpQueued || !lastDoc) return;
    catchUpQueued = true;
    // Deferred one tick: a 'focusout' fires before the DOM settles on
    // what's newly focused (e.g. tabbing between two fields in the same
    // card), so isProtected's activeElement check needs that tick to see
    // the real end state, not a transient null.
    setTimeout(() => {
      catchUpQueued = false;
      reconcile(lastDoc);
    }, 0);
  }
  // Capture-phase: 'focusout' doesn't bubble the way click does, and a
  // closed <details> fires no event at all other than 'toggle' (which also
  // doesn't bubble) — both are listened for at the document root in capture
  // phase so this fires regardless of where in a card it happens.
  document.addEventListener("focusout", scheduleCatchUp, true);
  document.addEventListener(
    "toggle",
    (e) => {
      if (e.target instanceof HTMLDetailsElement && !e.target.open) scheduleCatchUp();
    },
    true,
  );

  // ---- Reconciliation ------------------------------------------------------
  function entityKey(el) {
    if (!el.dataset) return null;
    if (el.dataset.placeholder !== undefined) return "placeholder";
    if (el.dataset.itemId) return "item:" + el.dataset.itemId;
    if (el.dataset.applicationId) return "app:" + el.dataset.applicationId;
    if (el.dataset.moveoutId) return "moveout:" + el.dataset.moveoutId;
    return null;
  }

  // Has the person started doing something in here that a wholesale replace
  // would destroy? Computed on demand (no dirty-tracking listeners needed):
  // a text/textarea's current value differs from the one it was rendered
  // with, a <select> has moved off its first option, a file's been chosen,
  // a <details> is expanded, or focus is presently inside it.
  function isProtected(el) {
    if (composing) return true;
    const active = document.activeElement;
    if (active && active !== document.body && el.contains(active)) return true;
    if (el.querySelector("details[open]")) return true;
    for (const input of el.querySelectorAll(
      'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=file]), textarea',
    )) {
      if (input.value !== input.defaultValue) return true;
    }
    for (const sel of el.querySelectorAll("select")) {
      if (sel.selectedIndex > 0) return true;
    }
    for (const file of el.querySelectorAll("input[type=file]")) {
      if (file.files && file.files.length > 0) return true;
    }
    return false;
  }

  // Patches the parts that are always safe to update even while the rest of
  // `oldEl` is protected: the status badge's text/tone, read-only shared
  // data that just became visible (the pickup address), and whether an open
  // sub-form can still be submitted. Never touches an input's value, a file
  // selection, or what's selected in a <select>.
  function patchSafeBits(oldEl, newEl) {
    const oldBadge = oldEl.querySelector(".item-badge");
    const newBadge = newEl.querySelector(".item-badge");
    if (oldBadge && newBadge && oldBadge.textContent !== newBadge.textContent) {
      oldBadge.textContent = newBadge.textContent;
    }
    const oldCard = oldEl.matches(".item-card") ? oldEl : oldEl.querySelector(".item-card");
    const newCard = newEl.matches(".item-card") ? newEl : newEl.querySelector(".item-card");
    if (oldCard && newCard && oldCard.className !== newCard.className) oldCard.className = newCard.className;

    if (oldEl.dataset.itemId) syncItemAvailability(oldEl, newEl.dataset.itemStatus);
    if (oldEl.dataset.applicationId) syncApplicationStatus(oldEl, newEl);
    reconcileSelects(oldEl, newEl);
  }

  // Bug fix (crit-9 review): previously an application card's status badge
  // text updated even while protected, but nothing else did — so a request
  // that got confirmed while its "Change pickup time" form was open showed
  // "Confirmed — pickup details below" with no pickup address, and that
  // now-meaningless timeslot-change control stayed enabled. Both the pickup
  // address and the cancel/change-timeslot controls' validity are read-only
  // shared facts, safe to apply immediately without touching anything the
  // person actually typed.
  function syncApplicationStatus(oldEl, newEl) {
    const newStatus = newEl.dataset.applicationStatus;
    if (!newStatus || oldEl.dataset.applicationStatus === newStatus) return;
    oldEl.dataset.applicationStatus = newStatus;

    const newSpot = newEl.querySelector("[data-pickup-spot]");
    const oldSpot = oldEl.querySelector("[data-pickup-spot]");
    if (newSpot && !oldSpot) {
      (oldEl.querySelector(".item-main") || oldEl).appendChild(document.importNode(newSpot, true));
    } else if (!newSpot && oldSpot) {
      oldSpot.remove();
    }

    // Changing the pickup time only makes sense while still pending.
    if (newStatus !== "pending") {
      oldEl.querySelectorAll('form[action*="/timeslot"] button[type="submit"]').forEach((b) => {
        b.disabled = true;
      });
    }
    // cancelled/completed are terminal (CLAUDE.md) — pending/confirmed can
    // still be cancelled.
    if (newStatus === "cancelled" || newStatus === "completed") {
      oldEl.querySelectorAll('form[action*="/cancel"] button[type="submit"]').forEach((b) => {
        b.disabled = true;
      });
    }
  }

  // Bug fix (crit-9 review): an entity (item or application) that drops out
  // of its list entirely — withdrawn, or a confirmed booking that moved from
  // "upcoming" to "completed" — used to just sit there unchanged if it was
  // protected, with its stale status, a form that still looked submittable,
  // and no indication anything had happened. This keeps the person's input
  // (never clears it), but makes clear the entity no longer matches reality
  // and disables every action on it, so nothing stale can still be
  // submitted. The actual DOM removal happens on the next reconcile after
  // the person stops protecting it (see scheduleCatchUp above) — this only
  // needs to stop it from acting valid in the meantime.
  const GONE_NOTE = "This no longer matches the current state — your input is kept, and this will update once you're done editing.";
  function markGone(el) {
    if (el.dataset.liveGone) return;
    el.dataset.liveGone = "1";
    el.querySelectorAll('button[type="submit"]').forEach((b) => {
      b.disabled = true;
    });
    if (el.querySelector("[data-live-note]")) return;
    // shortcut: no visible host inside a <tr> (the completed-history table
    // never contains a form, so it's never protected and never reaches
    // here); skip the note there rather than build table-specific markup.
    const host = el.querySelector(".item-main") || (el.tagName === "LI" ? el : null);
    if (!host) return;
    const note = document.createElement("p");
    note.className = "error-inline";
    note.setAttribute("data-live-note", "");
    note.setAttribute("role", "alert");
    note.textContent = GONE_NOTE;
    host.prepend(note);
  }

  const UNAVAILABLE_NOTE = "This item is no longer available — your request can't be submitted.";

  function syncItemAvailability(oldEl, newStatus) {
    if (!newStatus || oldEl.dataset.itemStatus === newStatus) return;
    oldEl.dataset.itemStatus = newStatus;
    const form = oldEl.querySelector("details.edit-details form");
    if (!form) return;
    const submitBtn = form.querySelector('button[type="submit"]');
    let note = form.querySelector("[data-live-note]");
    if (newStatus !== "open") {
      if (submitBtn) submitBtn.disabled = true;
      if (!note) {
        note = document.createElement("p");
        note.className = "error-inline";
        note.setAttribute("data-live-note", "");
        note.setAttribute("role", "alert");
        note.textContent = UNAVAILABLE_NOTE;
        form.prepend(note);
      }
    } else {
      if (submitBtn) submitBtn.disabled = false;
      if (note) note.remove();
    }
  }

  // New pickup times should still show up in an open apply/edit form even
  // while its own fields are protected — without silently changing what the
  // person already selected. Removes options only if they're not the one
  // currently chosen (a stale selection is instead caught, and explained,
  // by the server's own validation when they submit).
  function reconcileSelects(oldEl, newEl) {
    for (const oldSelect of oldEl.querySelectorAll("select[id]")) {
      const newSelect = newEl.querySelector("select[id=\"" + oldSelect.id + "\"]");
      if (!newSelect) continue;
      const newValues = new Set(Array.from(newSelect.options).map((o) => o.value));
      const oldValues = new Set(Array.from(oldSelect.options).map((o) => o.value));
      for (const opt of Array.from(oldSelect.options)) {
        if (!newValues.has(opt.value) && opt.value !== oldSelect.value) opt.remove();
      }
      for (const opt of Array.from(newSelect.options)) {
        if (!oldValues.has(opt.value)) oldSelect.add(document.importNode(opt, true));
      }
    }
  }

  function reconcileList(oldList, newList) {
    if (!oldList || !newList) return;
    const oldByKey = new Map();
    for (const el of Array.from(oldList.children)) {
      const key = entityKey(el);
      if (key) oldByKey.set(key, el);
    }
    const newEntities = Array.from(newList.children)
      .map((el) => [entityKey(el), el])
      .filter(([key]) => key);
    const keep = new Set(newEntities.map(([key]) => key));

    for (const [key, el] of oldByKey) {
      if (keep.has(key)) continue;
      if (isProtected(el)) {
        markGone(el); // kept on screen (input preserved) but disabled — see markGone
      } else {
        el.remove();
        oldByKey.delete(key);
      }
    }

    // Bug fix (crit-9 review): this used to call prev.after(el) /
    // oldList.prepend(el) unconditionally for every entity, every sync —
    // which moves the node in the DOM even when its position hasn't
    // changed. Moving a node that contains the currently-focused element
    // drops focus to <body> (the DOM doesn't preserve it across a
    // reposition), so a person mid-form would get kicked out of their own
    // input by someone else's unrelated change elsewhere on the same list.
    // Now a node is only moved when it isn't already directly after `prev`
    // (or, for the first entity, already first) — the common case (nothing
    // reordered, just a status changed in place) touches node order not at
    // all.
    // A "gone" entity (markGone'd above) stays in the DOM but isn't in
    // newEntities, so it must not count when deciding whether the *next*
    // entity is already adjacent to `prev` — otherwise a genuinely
    // unmoved, possibly-protected card right after a gone one would look
    // "out of place" purely because of the gone card sitting between them,
    // and get repositioned for no reason (dropping its focus).
    function previousSignificant(el) {
      let sib = el.previousElementSibling;
      while (sib && sib.dataset && sib.dataset.liveGone) sib = sib.previousElementSibling;
      return sib;
    }
    function firstSignificant(list) {
      let el = list.firstElementChild;
      while (el && el.dataset && el.dataset.liveGone) el = el.nextElementSibling;
      return el;
    }

    let prev = null;
    for (const [key, newEl] of newEntities) {
      let el = oldByKey.get(key);
      if (!el) {
        // Not yet in the DOM at all — always needs inserting below.
        el = document.importNode(newEl, true);
        enhanceForms(el);
      } else if (key === "placeholder") {
        if (el.innerHTML !== newEl.innerHTML) el.innerHTML = newEl.innerHTML;
      } else if (!isProtected(el)) {
        if (el.outerHTML !== newEl.outerHTML) {
          // replaceWith keeps the fresh node at the old node's position, so
          // this does not itself need a reposition — the inPlace check
          // below still runs against that position to catch real reorders.
          const fresh = document.importNode(newEl, true);
          enhanceForms(fresh);
          el.replaceWith(fresh);
          el = fresh;
        }
      } else {
        patchSafeBits(el, newEl);
      }
      const inPlace = el.parentNode === oldList && (prev ? previousSignificant(el) === prev : el === firstSignificant(oldList));
      if (!inPlace) {
        if (prev) prev.after(el);
        else oldList.prepend(el);
      }
      prev = el;
    }
  }

  // Bug fix (crit-9 review): reconcileList only ever touched a list's
  // children. On the home page, "Your move-out pages" and "Your requests"
  // are each wrapped in a `<section hidden>` that the server only omits
  // `hidden` from when that list is non-empty (src/views/home.ts) — so the
  // very first item ever appearing in an open tab updated the `<ul>` but
  // left the whole section hidden around it, and the reverse (the last row
  // removed) left an empty, visible section with nothing in it. A section's
  // hidden state is itself shared read-only state — showing or hiding it
  // never touches anything a person typed, so it's always safe to sync
  // immediately, protected list or not.
  function syncSectionVisibility(newDoc) {
    document.querySelectorAll("[data-live-section]").forEach((oldSection) => {
      const key = oldSection.getAttribute("data-live-section");
      const newSection = newDoc.querySelector('[data-live-section="' + key + '"]');
      if (!newSection) return;
      oldSection.hidden = newSection.hasAttribute("hidden");
    });
  }

  function reconcile(newDoc) {
    document.querySelectorAll("[data-live-list]").forEach((oldList) => {
      const key = oldList.getAttribute("data-live-list");
      reconcileList(oldList, newDoc.querySelector('[data-live-list="' + key + '"]'));
    });
    syncSectionVisibility(newDoc);
  }

  // ---- Progressive form enhancement ----------------------------------------
  // Opt-in via data-ajax (src/views/*.ts): posts through fetch so a server
  // rejection (a stale confirm, an expired timeslot, a duplicate request)
  // shows up as an inline message instead of navigating to a blank
  // plain-text error page and losing whatever the person had typed. A
  // success still ends in a normal navigation — to wherever the server
  // redirected — exactly like the no-JS form it progressively enhances.
  function enhanceForms(root) {
    root.querySelectorAll("form[data-ajax]").forEach((form) => {
      if (form.dataset.liveEnhanced) return;
      form.dataset.liveEnhanced = "1";
      form.addEventListener("submit", onFormSubmit);
    });
  }

  function clearFormError(form) {
    const prev = form.querySelector(":scope > [data-form-error]");
    if (prev) prev.remove();
  }

  function showFormError(form, message) {
    clearFormError(form);
    const p = document.createElement("p");
    p.className = "error-inline";
    p.setAttribute("role", "alert");
    p.setAttribute("data-form-error", "");
    p.textContent = message;
    form.prepend(p);
  }

  async function onFormSubmit(event) {
    const form = event.target;
    event.preventDefault();
    clearFormError(form);
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await fetch(form.action, {
        method: (form.method || "POST").toUpperCase(),
        body: new FormData(form),
        credentials: "same-origin",
      });
      if (res.ok) {
        // A network error between here and the response arriving is a
        // genuinely unknown outcome — but a response at all means the
        // server has already committed (or rejected) the write, so it's
        // safe to navigate rather than guess by re-submitting.
        window.location.assign(res.url || form.action);
        return;
      }
      showFormError(form, (await res.text()).trim() || "That didn't work — please try again.");
    } catch {
      showFormError(form, "Could not reach the server — your input is unchanged, try again.");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  // ---- Lifecycle: recalibrate when it matters, clean up when we leave -----
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (!es || es.readyState === EventSource.CLOSED) connect();
    else resync();
  });

  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      backoff = 1000;
      connect();
    }
  });

  window.addEventListener("pagehide", () => {
    closeStream();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (syncRetryTimer) clearTimeout(syncRetryTimer);
  });

  enhanceForms(document);
  connect();
})();
