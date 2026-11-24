import assert from "node:assert/strict";
import test from "node:test";
import { createTurnMonitor } from "../packages/server/src/orchestrator/execution/turn-monitor.ts";

test("turn monitor reports a stalled leaf once, skips tool and human waits, and clears on recovery", (t) => {
	let now = 0;
	const current: Array<{ active: string[]; raised: string[] }> = [];
	const monitor = createTurnMonitor(
		(active, raised) =>
			current.push({
				active: active.map(({ memberName }) => memberName),
				raised: raised.map(({ memberName }) => memberName),
			}),
		{ now: () => now },
	);
	t.after(() => monitor.close());
	const lead = monitor.begin({ memberId: "lead", memberName: "Lead" });
	const engineer = monitor.begin({ memberId: "eng", memberName: "Engineer", assignmentNumber: 1 });
	const verifier = monitor.begin({ memberId: "qa", memberName: "Verifier", assignmentNumber: 2 });
	const analyst = monitor.begin({ memberId: "analyst", memberName: "Analyst", assignmentNumber: 3 });
	const returnFromChild = lead.wait();
	const answerDialog = analyst.wait();
	engineer.toolStarted("tests", "Running tests");
	now = 180_000;
	monitor.scan();
	monitor.scan();
	assert.deepEqual(current, [{ active: ["Verifier"], raised: ["Verifier"] }]);
	verifier.pulse("received result");
	assert.deepEqual(current.at(-1), { active: [], raised: [] });
	engineer.toolFinished("tests", "Tests finished");
	answerDialog();
	returnFromChild();
	verifier.stop();
	now += 179_999;
	monitor.scan();
	assert.equal(current.length, 2);
	now += 1;
	monitor.scan();
	assert.deepEqual(current.at(-1), {
		active: ["Lead", "Engineer", "Analyst"],
		raised: ["Lead", "Engineer", "Analyst"],
	});
});
