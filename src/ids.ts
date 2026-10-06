import { randomBytes, randomUUID } from "node:crypto";

// Member and item ids: no entropy requirement of their own (they're not
// secrets), just uniqueness, so a plain UUID is enough.
export const newId = (): string => randomUUID();

// Short and URL-friendly. Not a secret — it's the path everyone in a fridge
// shares — so modest entropy is fine.
export const newFridgeId = (): string => randomBytes(6).toString("base64url");

// This is the only thing that lets a stranger join a fridge, so it gets far
// more entropy than the fridge id, and the app never logs it (see CLAUDE.md).
export const newInviteToken = (): string => randomBytes(18).toString("base64url");

// Identifies a browser across visits. Also unguessable: anyone who could
// predict it could impersonate another member.
export const newDeviceId = (): string => randomBytes(18).toString("base64url");
