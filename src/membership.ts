import { db, type Fridge, type Member } from "./db.ts";

export function getFridge(fridgeId: string): Fridge | undefined {
  return db.prepare("SELECT * FROM fridges WHERE id = ?").get(fridgeId) as Fridge | undefined;
}

export function findFridgeByInviteToken(token: string): Fridge | undefined {
  return db.prepare("SELECT * FROM fridges WHERE invite_token = ?").get(token) as Fridge | undefined;
}

export function getMember(fridgeId: string, deviceId: string): Member | undefined {
  return db
    .prepare("SELECT * FROM members WHERE fridge_id = ? AND device_id = ?")
    .get(fridgeId, deviceId) as Member | undefined;
}

export function listMembers(fridgeId: string): Member[] {
  return db.prepare("SELECT * FROM members WHERE fridge_id = ?").all(fridgeId) as unknown as Member[];
}

export function membersById(fridgeId: string): Map<string, Member> {
  return new Map(listMembers(fridgeId).map((member) => [member.id, member]));
}
