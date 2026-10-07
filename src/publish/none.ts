import type { Publisher } from "../types.ts";
// Restricted claims are not published anywhere. They exist in the issuer's own
// store and are answered only through an authorised query.
export function createNullPublisher(): Publisher {
  return {
    id: "none",
    async publish() {
      return {};
    },
    async remove() {
      return {};
    },
    async describe() {
      return {};
    },
  };
}
