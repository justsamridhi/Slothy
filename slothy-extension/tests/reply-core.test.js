
const assert = require("node:assert/strict");
const core = require("../reply-core.js");

describe("Slothy reply-core", function () {
  describe("splitIntoPassages", function () {
    it("splits sentences and numbers them in order", function () {
      const result = core.splitIntoPassages(
        "Please send the report. Confirm the date!"
      );

      assert.deepEqual(result, [
        { id: 1, text: "Please send the report." },
        { id: 2, text: "Confirm the date!" }
      ]);
    });

    it("returns an empty array for empty input", function () {
      assert.deepEqual(core.splitIntoPassages(""), []);
      assert.deepEqual(core.splitIntoPassages(null), []);
    });
  });

  describe("extractEntities", function () {
    it("extracts dates, email addresses and URLs", function () {
      const result = core.extractEntities(
        "Meet on 2026-10-24. Email a@b.com and visit https://example.com"
      );

      assert.ok(result.isoDate.includes("2026-10-24"));
      assert.ok(result.email.includes("a@b.com"));
      assert.ok(result.url.some(url => url.startsWith("https://example.com")));
    });

    it("deduplicates repeated matches", function () {
      const result = core.extractEntities(
        "Email a@b.com or contact a@b.com"
      );

      assert.equal(result.email.length, 1);
    });
  });

  describe("verifyAsk", function () {
    it("accepts an ask with source overlap and matching numbers", function () {
      const passages = [
        { id: 1, text: "Please submit report 42 tomorrow." }
      ];

      const result = core.verifyAsk(
        { text: "Submit report 42", source_ids: [1] },
        passages
      );

      assert.deepEqual(result, { ok: true });
    });

    it("rejects an ask without source IDs", function () {
      const result = core.verifyAsk(
        { text: "Submit report", source_ids: [] },
        []
      );

      assert.equal(result.ok, false);
      assert.equal(result.reason, "no source ids");
    });

    it("rejects mismatched numbers", function () {
      const result = core.verifyAsk(
        { text: "Submit report 99", source_ids: [1] },
        [{ id: 1, text: "Submit report 42" }]
      );

      assert.equal(result.ok, false);
      assert.equal(result.reason, "number mismatch");
    });
  });

  describe("fallbackAsks", function () {
    it("detects requests and questions", function () {
      const asks = core.fallbackAsks(
        "Please send the report. Can you confirm the date?"
      );

      assert.equal(asks.length, 2);
      assert.equal(asks[0].type, "request");
      assert.equal(asks[1].type, "question");
      assert.deepEqual(asks.map(ask => ask.source_ids), [[1], [2]]);
    });

    it("returns no asks when there are no request cues", function () {
      assert.deepEqual(
        core.fallbackAsks("The sky is blue. The grass is green."),
        []
      );
    });
  });

  describe("coverageCheck", function () {
    it("reports covered and missing asks", function () {
      const asks = [
        { text: "Please send the report", type: "request", source_ids: [1] },
        { text: "Confirm the meeting date", type: "request", source_ids: [2] }
      ];

      const result = core.coverageCheck(
        "I will send the report.",
        asks
      );

      assert.equal(result.total, 2);
      assert.equal(result.coveredCount, 1);
      assert.equal(result.missing.length, 1);
      assert.equal(result.missing[0].text, "Confirm the meeting date");
    });

    it("handles an empty ask list", function () {
      const result = core.coverageCheck("Hello", []);

      assert.equal(result.total, 0);
      assert.equal(result.coveredCount, 0);
      assert.deepEqual(result.missing, []);
    });
  });

  describe("hashMessage", function () {
    it("returns a deterministic hash for the same input", function () {
      assert.equal(
        core.hashMessage({ text: "Hello" }),
        core.hashMessage({ text: "Hello" })
      );
    });

    it("changes the hash when the input changes", function () {
      assert.notEqual(
        core.hashMessage({ text: "Hello" }),
        core.hashMessage({ text: "Goodbye" })
      );
    });
  });

  describe("cache", function () {
    it("stores and retrieves cached data", function () {
      const key = "test-key-" + Date.now();
      const value = { summary: "A test summary" };

      core.setCached(key, value);

      assert.deepEqual(core.getCached(key), value);
    });

    it("returns undefined for a missing key", function () {
      assert.equal(
        core.getCached("missing-key-" + Date.now()),
        undefined
      );
    });
  });
});
