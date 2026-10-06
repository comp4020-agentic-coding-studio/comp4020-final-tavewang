import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { newDeviceId } from "./ids.ts";

declare module "hono" {
  interface ContextVariableMap {
    deviceId: string;
  }
}

const COOKIE_NAME = "device";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// Every visitor gets an unguessable device cookie on their first request,
// before they've joined (or created) any fridge. Membership is keyed off
// this id, not off a nickname, so two people who both type "Sam" are still
// two different members, and the same browser keeps its identity across a
// refresh without needing an account.
export const deviceMiddleware: MiddlewareHandler = async (c, next) => {
  let deviceId = getCookie(c, COOKIE_NAME);
  if (!deviceId) {
    deviceId = newDeviceId();
    setCookie(c, COOKIE_NAME, deviceId, {
      httpOnly: true,
      sameSite: "Lax",
      secure: new URL(c.req.url).protocol === "https:",
      path: "/",
      maxAge: ONE_YEAR_SECONDS,
    });
  }
  c.set("deviceId", deviceId);
  await next();
};
