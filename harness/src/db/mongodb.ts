import { MongoClient, type Db, type Collection, type ObjectId } from "mongodb";
import { config } from "../config.js";

export type Permission = "menu.write" | "pricing.write" | "objectives.manage";

export interface Tenant {
  _id: string;
  name: string;
  createdAt: Date;
}

export interface Restaurant {
  _id: string;
  tenantId: string;
  name: string;
  platform: "ordersco";
  sandboxUrl: string;
  createdAt: Date;
}

export interface User {
  _id: string;
  tenantId: string;
  name: string;
  /** Normalized iMessage handles (E.164 phones, lowercase emails). */
  handles: string[];
  status: "active" | "disabled";
  createdAt: Date;
}

export interface Membership {
  _id: string;
  tenantId: string;
  userId: string;
  restaurantId: string;
  role: "owner" | "manager";
  permissions: Permission[];
}

export type ActionRunStatus = "pending" | "running" | "verified" | "failed" | "denied";

export interface ActionRun {
  _id?: ObjectId;
  tenantId: string;
  restaurantId: string;
  userId: string;
  skill: string;
  params: Record<string, unknown>;
  status: ActionRunStatus;
  /** Source message id (e.g. BlueBubbles guid) so a redelivered message is not executed twice. */
  idempotencyKey: string;
  result?: Record<string, unknown>;
  traceId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Objective {
  _id?: ObjectId;
  tenantId: string;
  restaurantId: string;
  userId: string;
  text: string;
  metric?: string;
  baseline?: number;
  target?: number;
  deadline?: Date;
  status: "active" | "achieved" | "abandoned";
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditEvent {
  _id?: ObjectId;
  tenantId: string | null;
  type: string;
  actorUserId: string | null;
  data: Record<string, unknown>;
  at: Date;
}

let client: MongoClient | undefined;
let db: Db | undefined;

export async function connect(uri = config.mongodbUri, dbName = config.mongodbDb): Promise<Db> {
  if (db) return db;
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  await ensureIndexes(db);
  return db;
}

export async function disconnect(): Promise<void> {
  await client?.close();
  client = undefined;
  db = undefined;
}

function getDb(): Db {
  if (!db) throw new Error("MongoDB not connected; call connect() first");
  return db;
}

export const collections = {
  tenants: (): Collection<Tenant> => getDb().collection("tenants"),
  restaurants: (): Collection<Restaurant> => getDb().collection("restaurants"),
  users: (): Collection<User> => getDb().collection("users"),
  memberships: (): Collection<Membership> => getDb().collection("memberships"),
  actionRuns: (): Collection<ActionRun> => getDb().collection("owner_requests"),
  objectives: (): Collection<Objective> => getDb().collection("objectives"),
  auditEvents: (): Collection<AuditEvent> => getDb().collection("audit_events"),
};

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection("users").createIndex({ handles: 1 }, { unique: true }),
    db.collection("memberships").createIndex({ tenantId: 1, userId: 1, restaurantId: 1 }, { unique: true }),
    db.collection("owner_requests").createIndex({ tenantId: 1, idempotencyKey: 1 }, { unique: true }),
    db.collection("owner_requests").createIndex({ tenantId: 1, restaurantId: 1, createdAt: -1 }),
    db.collection("objectives").createIndex({ tenantId: 1, restaurantId: 1, status: 1 }),
    db.collection("audit_events").createIndex({ tenantId: 1, at: -1 }),
  ]);
}

export async function ping(): Promise<boolean> {
  const res = await getDb().command({ ping: 1 });
  return res.ok === 1;
}
