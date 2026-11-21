// Authorisation: which batches can this user SEE?
// One function used by every read endpoint and by realtime, so the rule lives in one place.
import type { Prisma, User } from "@prisma/client";

/** Prisma filter limiting batches to those the user may see. */
export function visibleBatchesWhere(user: User): Prisma.BatchWhereInput {
  switch (user.role) {
    case "CENTRE":
      return { centreId: user.centreId ?? "__none__" };
    case "DISTRICT_OFFICER":
      // Officers see only their own district, and never other centres' drafts.
      return { centre: { districtId: user.districtId ?? "__none__" }, status: { not: "DRAFT" } };
    case "QUALITY":
    case "STATE_OFFICE":
      return { status: { not: "DRAFT" } };
  }
}

/** Same rule, for an event's routing scope (used by the realtime stream). */
export function canSeeScope(user: User, scope: { centreId: string; districtId: string }): boolean {
  switch (user.role) {
    case "CENTRE":
      return user.centreId === scope.centreId;
    case "DISTRICT_OFFICER":
      return user.districtId === scope.districtId;
    case "QUALITY":
    case "STATE_OFFICE":
      return true;
  }
}
