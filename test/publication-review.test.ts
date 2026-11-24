import assert from "node:assert/strict";
import test from "node:test";
import {
	type ReviewToolTrace,
	specialistsBeforePublication,
} from "../packages/server/src/demo/publication-review-evidence.ts";

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
	const publish = trace({ toolName: "save_space_page", started: 5, ended: 6 });
	publish.args = { title: "设计方案" };
	assert.deepEqual(specialistsBeforePublication([trace({}), publish], "设计方案"), ["engineering-manager"]);
	assert.deepEqual(
		specialistsBeforePublication([trace({}), { ...publish, toolName: "publish_deliverable" }], "设计方案"),
		["engineering-manager"],
	);
	assert.deepEqual(
		specialistsBeforePublication(
			[
				trace({ isError: true }),
				trace({ memberId: "qa-manager" }),
				trace({ ended: undefined }),
				trace({ ended: 7 }),
				trace({ args: { memberId: 1 } }),
				publish,
			],
			"设计方案",
		),
		[],
	);
	assert.deepEqual(specialistsBeforePublication([trace({})], "设计方案"), []);
	assert.deepEqual(specialistsBeforePublication([trace({}), { ...publish, isError: true }], "设计方案"), []);
	assert.deepEqual(
		specialistsBeforePublication(
			[publish, trace({ started: 7, ended: 8 }), { ...publish, started: 9, ended: 10 }],
			"设计方案",
		),
		["engineering-manager"],
	);
});
