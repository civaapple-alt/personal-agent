import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { preparePstackRuntime, readPstackResource } from "../src/demo/pstack-fixture.ts";

async function createPack(root: string) {
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "pstack", version: "fixture-1" }));
	for (const name of ["poteto-mode", "principle-prove-it-works", "principle-fix-root-causes"]) {
		await mkdir(join(root, "skills", name), { recursive: true });
		await writeFile(
			join(root, "skills", name, "SKILL.md"),
			`---\nname: ${name}\ndescription: Fixture ${name}\ndisable-model-invocation: true\n---\n# ${name}\nSOURCE_${name}\n`,
		);
	}
	await mkdir(join(root, "skills", "poteto-mode", "playbooks"));
	await writeFile(
		join(root, "skills", "poteto-mode", "playbooks", "investigation.md"),
		"Read-only investigation fixture\n",
	);
	await writeFile(join(root, "skills", "poteto-mode", "playbooks", "bug-fix.md"), "Bug fix fixture\n");
}

test("pstack loader reads actual method resources and rejects escapes, scripts and missing mode", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pa-pstack-loader-"));
	try {
		const root = join(dir, "pack");
		await createPack(root);
		const runtime = await preparePstackRuntime(root);
		assert.equal(runtime.version, "fixture-1");
		assert.equal(runtime.skills.length, 3);
		assert.match(runtime.modeSha256, /^[a-f0-9]{64}$/);
		const method = await readPstackResource(root, "poteto-mode", "playbooks/investigation.md");
		assert.equal(method.text, "Read-only investigation fixture\n");
		await writeFile(join(dir, "outside.md"), "must not be read");
		await symlink(join(dir, "outside.md"), join(root, "skills", "poteto-mode", "outside.md"));
		await assert.rejects(() => readPstackResource(root, "poteto-mode", "outside.md"), /inside/);
		await assert.rejects(() => readPstackResource(root, "poteto-mode", "../../../outside.md"), /inside/);
		await assert.rejects(() => readPstackResource(root, "poteto-mode", "script.sh"), /Markdown/);
		await assert.rejects(() => readPstackResource(root, "../outside"), /Invalid/);
		await writeFile(join(root, "skills", "poteto-mode", "large.md"), "x".repeat(262145));
		await assert.rejects(() => readPstackResource(root, "poteto-mode", "large.md"), /bounded/);
		await rm(join(root, "skills", "poteto-mode"), { recursive: true });
		await assert.rejects(() => preparePstackRuntime(root), /ENOENT/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
