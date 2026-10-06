import { randomBytes, randomUUID } from "node:crypto";

// Row ids (items, timeslots, applications, uploaded filenames): no entropy
// requirement of their own, just uniqueness.
export const newId = (): string => randomUUID();

// A move-out page's id doubles as its only URL — short and URL-friendly, with
// enough entropy that it isn't practically guessable, since it's the one
// thing standing between a stranger and the page at all (see src/session.ts
// and CLAUDE.md: it is NOT a management credential, only a visibility one).
export const newMoveoutId = (): string => randomBytes(9).toString("base64url");

// Identifies a browser across visits.
export const newDeviceId = (): string => randomBytes(18).toString("base64url");
