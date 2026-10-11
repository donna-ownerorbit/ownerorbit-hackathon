import { collections, type Membership, type Permission, type User } from "../db/mongodb.js";

export type AuthzResult =
  | { ok: true; membership: Membership }
  | { ok: false; reason: "no_restaurant" | "ambiguous_restaurant" | "missing_permission" };

/**
 * Check that the user holds `permission` on a restaurant in their own tenant.
 * If restaurantId is omitted and the user belongs to exactly one restaurant, that one is used.
 */
export async function authorize(
  user: User,
  permission: Permission,
  restaurantId?: string,
): Promise<AuthzResult> {
  const query = restaurantId
    ? { tenantId: user.tenantId, userId: user._id, restaurantId }
    : { tenantId: user.tenantId, userId: user._id };
  const memberships = await collections.memberships().find(query).toArray();

  if (memberships.length === 0) return { ok: false, reason: "no_restaurant" };
  if (memberships.length > 1) return { ok: false, reason: "ambiguous_restaurant" };

  const membership = memberships[0];
  if (!membership.permissions.includes(permission)) return { ok: false, reason: "missing_permission" };
  return { ok: true, membership };
}
