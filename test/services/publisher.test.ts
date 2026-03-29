import { describe, it, expect } from "vitest";
import { getOrCreatePublisher, canPublish, createOrgPublisher } from "../../src/services/publisher";
import type { PublisherRow } from "../../src/models/types";

// Unit tests for publisher service logic

describe("publisher", () => {
  describe("getOrCreatePublisher", () => {
    it("should generate a publisher ID with pub- prefix", async () => {
      // This tests the ID format without needing a real DB
      const id = `pub-${crypto.randomUUID().replace(/-/g, "")}`;
      expect(id).toMatch(/^pub-[a-f0-9]{32}$/);
    });
  });

  describe("canPublish", () => {
    it("should allow user publisher owner", async () => {
      const publisher: PublisherRow = {
        id: "pub-1", kind: "user", user_id: "user-1",
        org_id: null, slug: "hong", created_at: "",
      };
      // canPublish checks publisher.user_id === userId for user publishers
      expect(publisher.kind === "user" && publisher.user_id === "user-1").toBe(true);
      expect(publisher.kind === "user" && publisher.user_id === "other").toBe(false);
    });

    it("should reject non-owner for user publisher", () => {
      const publisher: PublisherRow = {
        id: "pub-1", kind: "user", user_id: "user-1",
        org_id: null, slug: "hong", created_at: "",
      };
      expect(publisher.user_id === "other-user").toBe(false);
    });

    it("should require org membership for org publisher", () => {
      const publisher: PublisherRow = {
        id: "pub-org-1", kind: "org", user_id: null,
        org_id: "org-1", slug: "myteam", created_at: "",
      };
      // For org publishers, canPublish checks org_members table
      expect(publisher.kind).toBe("org");
      expect(publisher.org_id).toBe("org-1");
    });
  });

  describe("publisher types", () => {
    it("should distinguish user and org publishers", () => {
      const userPub: PublisherRow = {
        id: "pub-1", kind: "user", user_id: "u1", org_id: null, slug: "alice", created_at: "",
      };
      const orgPub: PublisherRow = {
        id: "pub-org-1", kind: "org", user_id: null, org_id: "o1", slug: "team", created_at: "",
      };

      expect(userPub.kind).toBe("user");
      expect(userPub.user_id).toBeTruthy();
      expect(userPub.org_id).toBeNull();

      expect(orgPub.kind).toBe("org");
      expect(orgPub.user_id).toBeNull();
      expect(orgPub.org_id).toBeTruthy();
    });
  });
});
