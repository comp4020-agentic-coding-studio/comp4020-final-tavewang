import { Hono } from "hono";
import { createAccount, verifyLogin, createSession, destroySession, claimAnonymousDataForAccount, hasUnclaimedAnonymousData } from "../auth.ts";
import { setSessionCookie, clearSessionCookie, getSessionCookie, safeNextPath } from "../session.ts";
import { registerView, loginView, accountClaimedView } from "../views/auth.ts";
import { getApplicationsWithContext } from "../ownership.ts";
import { logEvent } from "../log.ts";
import { notifyAccount, notifyDevice } from "../live.ts";

export const authRoutes = new Hono();

// `reason=signin_required` renders a specific, honest explanation ("you need
// to sign in to do that") rather than a bare form a visitor arrived at with
// no context — set only by this app's own redirects (home.ts, moveout.ts),
// never trusted as free text beyond that one fixed value.
function signinRequiredNotice(reason: string | undefined): string | undefined {
  return reason === "signin_required" ? "Log in or register first — that action needs an account." : undefined;
}

authRoutes.get("/register", (c) => {
  const next = safeNextPath(c.req.query("next"));
  if (c.get("account")) return c.redirect(next);
  return c.html(
    registerView({
      next,
      notice: signinRequiredNotice(c.req.query("reason")),
      hasUnclaimedData: hasUnclaimedAnonymousData(c.get("deviceId")),
    }),
  );
});

authRoutes.post("/register", async (c) => {
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const next = safeNextPath(String(form.get("next") ?? ""));

  const result = createAccount(email, password);
  if (!result.ok || !result.account) {
    logEvent({ event: "account.register", actor: c.get("deviceId"), outcome: "invalid", status: 400, reasonCode: "validation_failed" });
    return c.html(registerView({ error: result.error, email, next }), 400);
  }

  const account = result.account;
  const deviceId = c.get("deviceId");
  // The device that just registered may already have anonymous pages/
  // requests — link them to the brand-new account right away, so
  // registering never feels like it discarded what you'd already done in
  // this browser. Registering a brand-new account can't itself collide with
  // the new account's own prior applications (it has none yet), but the
  // claim still goes through the same conflict-tolerant path as login for
  // one reason: a registration can race a concurrent claim from a DIFFERENT
  // device already signing into this exact browser's device id onto some
  // other account in between — vanishingly rare, but handled the same way
  // rather than assumed away.
  const claimed = claimAnonymousDataForAccount(deviceId, account.id);

  const sessionId = createSession(account.id);
  setSessionCookie(c, sessionId);
  // Account creation and session creation are NOT conditional on the claim
  // pass succeeding in full — a registration always succeeds once the
  // account itself is created; `outcome` here is about account creation,
  // not about how many of this device's old rows got linked, which is
  // exactly what reasonCode records separately. See the fuller explanation
  // on the /login handler below, where this distinction is load-bearing
  // (a correct password must never fail because of an unrelated claim
  // conflict).
  logEvent({
    event: "account.register",
    actor: deviceId,
    outcome: "success",
    status: 200,
    reasonCode: `claimed_${claimed.moveouts}_${claimed.applications}_conflicted_${claimed.conflictedApplications}`,
  });

  // Lands on an intermediate confirmation page (what got linked), not a
  // silent redirect straight to `next` — the brief asks that the user
  // "actively complete" whatever action brought them here, not have it
  // replayed for them; this page's own link to `next` is that deliberate
  // next click. Any conflicted application is shown here directly, with
  // enough context to find and resolve it — never just a bare count.
  const conflictedApplications = getApplicationsWithContext(claimed.conflictedApplicationIds);
  return c.html(accountClaimedView(account, claimed, next, conflictedApplications));
});

authRoutes.get("/login", (c) => {
  const next = safeNextPath(c.req.query("next"));
  if (c.get("account")) return c.redirect(next);
  return c.html(
    loginView({
      next,
      notice: signinRequiredNotice(c.req.query("reason")),
      hasUnclaimedData: hasUnclaimedAnonymousData(c.get("deviceId")),
    }),
  );
});

authRoutes.post("/login", async (c) => {
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const next = safeNextPath(String(form.get("next") ?? ""));

  const account = verifyLogin(email, password);
  if (!account) {
    // Deliberately the same message whether the email doesn't exist or the
    // password is wrong (src/auth.ts#verifyLogin) — never confirm which
    // emails have accounts.
    logEvent({ event: "account.login", actor: c.get("deviceId"), outcome: "denied", status: 401, reasonCode: "bad_credentials" });
    return c.html(loginView({ error: "That email and password combination doesn't match an account.", email, next }), 401);
  }

  const deviceId = c.get("deviceId");
  // Same claim-on-sign-in pass as register: this device may have made
  // pages/requests anonymously before this login, on this same browser —
  // link them now rather than leaving them orphaned on the device id alone.
  //
  // A real bug, fixed this round: identity verification (the `verifyLogin`
  // check above — correct email + password) and the RESULT of this claim
  // pass are two separate things, and the login must succeed on the former
  // regardless of the latter. `claimAnonymousDataForAccount` used to throw
  // straight out of a single transaction the moment ANY one application hit
  // `applications_one_active_per_identity`'s unique constraint (this
  // account already having its own active request for an item this device
  // also had an unclaimed request for) — which meant a password that was
  // completely correct still got a 500 and no session, because of data this
  // device happened to be carrying that had nothing to do with whether the
  // credentials were right. `claimAnonymousDataForAccount` now isolates
  // each row's claim in its own SAVEPOINT (src/auth.ts) so one conflicting
  // row never aborts the whole pass — the session below is always created
  // once `verifyLogin` has already succeeded, independent of how the claim
  // turned out.
  const claimed = claimAnonymousDataForAccount(deviceId, account.id);

  const sessionId = createSession(account.id);
  setSessionCookie(c, sessionId);
  logEvent({
    event: "account.login",
    actor: deviceId,
    outcome: "success",
    status: 200,
    reasonCode: `claimed_${claimed.moveouts}_${claimed.applications}_conflicted_${claimed.conflictedApplications}`,
  });

  const conflictedApplications = getApplicationsWithContext(claimed.conflictedApplicationIds);
  return c.html(accountClaimedView(account, claimed, next, conflictedApplications));
});

authRoutes.post("/logout", (c) => {
  const sessionId = getSessionCookie(c);
  const account = c.get("account");
  if (sessionId) {
    // Deleting the row is what makes this cookie value immediately useless
    // everywhere, not just in this browser — a stolen cookie can't be
    // replayed after this, and another open tab on the same device loses
    // its session the moment it next makes a request.
    destroySession(sessionId);
  }
  clearSessionCookie(c);
  const deviceId = c.get("deviceId");
  logEvent({ event: "account.logout", actor: deviceId, outcome: "success", status: 200 });
  // Wake every other open tab on this device (and every other device signed
  // into the same account) RIGHT NOW, rather than waiting for the next
  // unrelated write to happen to touch something they're watching — this is
  // what makes a manage page or a claimant's own public page left open
  // elsewhere notice the logout within about a second instead of possibly
  // never, since src/public/live.js's resync only runs on an incoming
  // "sync" event (or the next visibilitychange/focus poll).
  notifyDevice(deviceId);
  if (account) notifyAccount(account.id);
  return c.redirect("/mine");
});
