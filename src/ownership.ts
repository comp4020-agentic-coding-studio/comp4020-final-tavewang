import { db, type Application, type Item, type Moveout } from "./db.ts";

export function getMoveout(id: string): Moveout | undefined {
  return db.prepare("SELECT * FROM moveouts WHERE id = ?").get(id) as Moveout | undefined;
}

export function isCreator(moveout: Moveout, deviceId: string): boolean {
  return moveout.creator_device_id === deviceId;
}

export function getItem(id: string): Item | undefined {
  return db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Item | undefined;
}

export function getApplication(id: string): Application | undefined {
  return db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as Application | undefined;
}

export function listItems(moveoutId: string): Item[] {
  return db.prepare("SELECT * FROM items WHERE moveout_id = ? ORDER BY created_at").all(moveoutId) as unknown as Item[];
}

export function listTimeslots(moveoutId: string) {
  return db
    .prepare("SELECT * FROM timeslots WHERE moveout_id = ? ORDER BY starts_at")
    .all(moveoutId) as unknown as import("./db.ts").Timeslot[];
}

export function listApplicationsForItem(itemId: string): Application[] {
  return db
    .prepare("SELECT * FROM applications WHERE item_id = ? ORDER BY created_at")
    .all(itemId) as unknown as Application[];
}

export function listApplicationsForDevice(deviceId: string): Application[] {
  return db
    .prepare("SELECT * FROM applications WHERE claimer_device_id = ? ORDER BY created_at DESC")
    .all(deviceId) as unknown as Application[];
}

export interface ApplicationWithContext extends Application {
  item_name: string;
  moveout_id: string;
  moveout_title: string;
}

// For the home page: "your requests" needs to link back to the moveout each
// application belongs to, without the caller having to join it by hand.
export function listApplicationsWithContext(deviceId: string): ApplicationWithContext[] {
  return db
    .prepare(
      `SELECT a.*, i.name AS item_name, m.id AS moveout_id, m.title AS moveout_title
       FROM applications a
       JOIN items i ON i.id = a.item_id
       JOIN moveouts m ON m.id = i.moveout_id
       WHERE a.claimer_device_id = ?
       ORDER BY a.created_at DESC`,
    )
    .all(deviceId) as unknown as ApplicationWithContext[];
}

export function listMoveoutsCreatedBy(deviceId: string): Moveout[] {
  return db
    .prepare("SELECT * FROM moveouts WHERE creator_device_id = ? ORDER BY created_at DESC")
    .all(deviceId) as unknown as Moveout[];
}
