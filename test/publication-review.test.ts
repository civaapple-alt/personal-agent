import assert from "node:assert/strict";
import test from "node:test";
import { type ReviewToolTrace, specialistsBeforePublication } from "../src/demo/publication-review-evidence.ts";

test("review evidence requires completed successful lead consultations before a successful publication begins", () => {
	const trace = (input: Partial<ReviewToolTrace>): ReviewToolTrace => ({
		memberId: "product-manager",
		toolName: "delegate_to_member",
		toolCallId: crypto.randomUUID(),
		args: { memberId: "engineering-manager" },
		started: 1,
		ended: 2,
		isError: false,
		...input,
	});
	const publish = trace({ toolName: "publish_deliverable", started: 5, ended: 6 });
	assert.deepEqual(specialistsBeforePublication([trace({}), publish]), ["engineering-manager"]);
	assert.deepEqual(
		specialistsBeforePublication([
			trace({ isError: true }),
			trace({ memberId: "qa-manager" }),
			trace({ ended: undefined }),
			trace({ ended: 7 }),
			trace({ args: { memberId: 1 } }),
			publish,
		]),
		[],
	);
	assert.deepEqual(specialistsBeforePublication([trace({})]), []);
	assert.deepEqual(specialistsBeforePublication([trace({}), { ...publish, isError: true }]), []);
});
