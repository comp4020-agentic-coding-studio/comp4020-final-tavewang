import { Hono } from "hono";
import { createAccount, verifyLogin, createSession, destroySession, claimAnonymousDataForAccount } from "../auth.ts";
import { setSessionCookie, clearSessionCookie, getSessionCookie } from "../session.ts";
import { registerView, loginView, accountClaimedView } from "../views/auth.ts";
import { logEvent } from "../log.ts";

export const authRoutes = new Hono();

authRoutes.get("/register", (c) => {
  if (c.get("account")) return c.redirect("/mine");
  return c.html(registerView());
});

authRoutes.post("/register", async (c) => {
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  const result = createAccount(email, password);
  if (!result.ok || !result.account) {
    logEvent({ event: "account.register", actor: c.get("deviceId"), outcome: "invalid", status: 400, reasonCode: "validation_failed" });
    return c.html(registerView({ error: result.error, email }), 400);
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

  return c.html(accountClaimedView(account, claimed));
});

authRoutes.get("/login", (c) => {
  if (c.get("account")) return c.redirect("/mine");
  return c.html(loginView());
});

authRoutes.post("/login", async (c) => {
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  const account = verifyLogin(email, password);
  if (!account) {
    // Deliberately the same message whether the email doesn't exist or the
    // password is wrong (src/auth.ts#verifyLogin) — never confirm which
    // emails have accounts.
    logEvent({ event: "account.login", actor: c.get("deviceId"), outcome: "denied", status: 401, reasonCode: "bad_credentials" });
    return c.html(loginView({ error: "That email and password combination doesn't match an account.", email }), 401);
  }

  const deviceId = c.get("deviceId");
  // Same claim-on-sign-in pass as register: this device may have made
  // pages/requests anonymously before this login, on this same browser —
  // link them now rather than leaving them orphaned on the device id alone.
  const claimed = claimAnonymousDataForAccount(deviceId, account.id);

  const sessionId = createSession(account.id);
  setSessionCookie(c, sessionId);
  logEvent({ event: "account.login", actor: deviceId, outcome: "success", status: 200, reasonCode: `claimed_${claimed.moveouts}_${claimed.applications}` });

  return c.html(accountClaimedView(account, claimed));
});

authRoutes.post("/logout", (c) => {
  const sessionId = getSessionCookie(c);
  if (sessionId) {
    // Deleting the row is what makes this cookie value immediately useless
    // everywhere, not just in this browser — a stolen cookie can't be
    // replayed after this, and another open tab on the same device loses
    // its session the moment it next makes a request.
    destroySession(sessionId);
  }
  clearSessionCookie(c);
  logEvent({ event: "account.logout", actor: c.get("deviceId"), outcome: "success", status: 200 });
  return c.redirect("/mine");
});
