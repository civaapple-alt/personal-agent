import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import spaceExtension from "../pa-extensions/space/pi/index.ts";
import { readWorkspaceFolder } from "../packages/server/src/orchestrator/execution/execution-context.ts";

test("readWorkspaceFolder imports UTF-8 workspace folder, skips noise/env dirs, and rejects traversal or binary files", async () => {
	const root = mkdtempSync(join(tmpdir(), "pa-space-folder-import-"));
	try {
		const demoDir = join(root, "prototypes/landing");
		mkdirSync(join(demoDir, "assets"), { recursive: true });
		mkdirSync(join(demoDir, "node_modules/pkg"), { recursive: true });
		mkdirSync(join(demoDir, ".git"), { recursive: true });
		writeFileSync(join(demoDir, "README.md"), "# Landing Demo\n");
		writeFileSync(join(demoDir, "index.html"), "<!doctype html><h1>Hello</h1>\n");
		writeFileSync(join(demoDir, "assets/app.js"), "console.log('ok');\n");
		writeFileSync(join(demoDir, "node_modules/pkg/index.js"), "ignored\n");
		writeFileSync(join(demoDir, ".git/HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(demoDir, ".env.local"), "SECRET=1\n");
		writeFileSync(join(demoDir, ".DS_Store"), "junk\n");

		const imported = await readWorkspaceFolder("@prototypes/landing", root);
		assert.equal(imported.relDir, "prototypes/landing");
		assert.deepEqual(
			imported.files.map((f) => f.subPath),
			["assets/app.js", "index.html", "README.md"],
		);

		// Reject traversal outside workspace
		await assert.rejects(() => readWorkspaceFolder("..", root), /must be inside the current workspace/);

		// Reject binary NUL file cleanly (all-or-nothing)
		const binDir = join(root, "with-binary");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(binDir, "ok.txt"), "hello\n");
		writeFileSync(join(binDir, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
		await assert.rejects(() => readWorkspaceFolder("with-binary", root), /nothing was published[\s\S]*logo\.bin/);

		// Reject empty folder
		const emptyDir = join(root, "empty");
		mkdirSync(emptyDir, { recursive: true });
		await assert.rejects(() => readWorkspaceFolder("empty", root), /no publishable UTF-8 text files/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pa-extensions/space/pi registers Pi-native promptSnippet, promptGuidelines, and sourceDir parameter", () => {
	const tools: Array<{ name: string; promptSnippet?: string; promptGuidelines?: string[]; parameters: unknown }> = [];
	const prev = process.env.PA_CAN_SAVE_SPACE;
	delete process.env.PA_CAN_SAVE_SPACE;
	try {
		spaceExtension({
			registerTool(tool) {
				tools.push(tool);
			},
		});
		const saveTool = tools.find((t) => t.name === "save_space_page");
		assert.ok(saveTool);
		assert.ok(saveTool.promptSnippet);
		assert.ok((saveTool.promptGuidelines?.length ?? 0) >= 2);
		const props = (saveTool.parameters as { properties?: Record<string, unknown> }).properties;
		assert.ok(props && "sourceDir" in props);
	} finally {
		if (prev !== undefined) process.env.PA_CAN_SAVE_SPACE = prev;
	}
});
