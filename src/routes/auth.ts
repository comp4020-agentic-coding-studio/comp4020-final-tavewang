import { Hono } from "hono";
import { createAccount, verifyLogin, createSession, destroySession, claimAnonymousDataForAccount, hasUnclaimedAnonymousData } from "../auth.ts";
import { setSessionCookie, clearSessionCookie, getSessionCookie, safeNextPath } from "../session.ts";
import { registerView, loginView, accountClaimedView } from "../views/auth.ts";
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
  // this browser.
  const claimed = claimAnonymousDataForAccount(deviceId, account.id);

  const sessionId = createSession(account.id);
  setSessionCookie(c, sessionId);
  logEvent({ event: "account.register", actor: deviceId, outcome: "success", status: 200, reasonCode: `claimed_${claimed.moveouts}_${claimed.applications}` });

  // Lands on an intermediate confirmation page (what got linked), not a
  // silent redirect straight to `next` — the brief asks that the user
  // "actively complete" whatever action brought them here, not have it
  // replayed for them; this page's own link to `next` is that deliberate
  // next click.
  return c.html(accountClaimedView(account, claimed, next));
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
  const claimed = claimAnonymousDataForAccount(deviceId, account.id);

  const sessionId = createSession(account.id);
  setSessionCookie(c, sessionId);
  logEvent({ event: "account.login", actor: deviceId, outcome: "success", status: 200, reasonCode: `claimed_${claimed.moveouts}_${claimed.applications}` });

  return c.html(accountClaimedView(account, claimed, next));
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
