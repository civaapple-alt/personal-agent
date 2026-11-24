import assert from "node:assert/strict";
import test from "node:test";
import { formatStartupBanner, isUsableLanIpv4 } from "../packages/server/src/server/boot.ts";

test("isUsableLanIpv4 filters loopback, APIPA, and RFC 2544 proxy TUN fake-IP ranges while keeping LAN and mesh IPs", () => {
	assert.equal(isUsableLanIpv4("192.168.50.45"), true);
	assert.equal(isUsableLanIpv4("10.0.1.24"), true);
	assert.equal(isUsableLanIpv4("172.16.0.10"), true);
	assert.equal(isUsableLanIpv4("100.88.12.34"), true);

	assert.equal(isUsableLanIpv4("198.18.0.1"), false);
	assert.equal(isUsableLanIpv4("198.19.255.254"), false);
	assert.equal(isUsableLanIpv4("169.254.12.34"), false);
	assert.equal(isUsableLanIpv4("127.0.0.1"), false);
	assert.equal(isUsableLanIpv4("0.0.0.0"), false);
	assert.equal(isUsableLanIpv4("not-an-ip"), false);
});

test("formatStartupBanner renders Pi-style startup summary for personal and team modes without V4 legacy text", () => {
	const personal = formatStartupBanner({
		host: "127.0.0.1",
		localUrl: "http://127.0.0.1:4310",
		lanUrls: [],
		summary: {
			version: "0.8.0",
			requireAuth: false,
			localPiResourcesInherited: true,
			pi: { available: true, executable: "pi", version: "1.6.0", error: null },
			nodeVersion: "v26.10.0",
			rootDir: "/tmp/pa-root",
			installRoot: "/tmp/pa-root",
			dbPath: "/tmp/pa-root/.data/personal-agent.db",
			sessionDir: "/tmp/pa-root/.data/pi-sessions",
			workspaceNames: ["personal-agent"],
			businessRoleIds: ["product-manager", "engineering-manager"],
			hasArchitectRole: true,
			extensionNames: ["worker-runtime", "space", "workflow", "self-inspect"],
			extraPiExtensions: [],
		},
	});
	assert.doesNotMatch(personal, /\bV4\b/);
	assert.match(personal, /Personal Agent v0\.8\.0 \(personal mode · loopback owner\)/);
	assert.match(personal, /Personal Agent workbench listening on http:\/\/127\.0\.0\.1:4310 \(bind 127\.0\.0\.1\)/);
	assert.match(personal, /\[Runtime\]\n {2}Pi CLI 1\.6\.0 \(pi\) · Node v26\.10\.0 · Local Pi resources: inherited/);
	assert.match(personal, /Docs: docs · Examples: examples/);
	assert.match(personal, /DB: \.data\/personal-agent\.db · Sessions: \.data\/pi-sessions/);
	assert.match(personal, /Workspaces \(1\): personal-agent/);
	assert.match(personal, /2 business roles: product-manager, engineering-manager \(\+ role-architect\)/);
	assert.match(personal, /\[Extensions\]\n {2}worker-runtime, space, workflow, self-inspect/);

	const team = formatStartupBanner({
		host: "0.0.0.0",
		localUrl: "http://127.0.0.1:4310",
		lanUrls: ["http://192.168.50.45:4310"],
		summary: {
			version: "0.8.0",
			requireAuth: true,
			localPiResourcesInherited: false,
			pi: {
				available: false,
				executable: "pi",
				version: null,
				error: "spawn pi ENOENT",
			},
			nodeVersion: "v26.10.0",
			rootDir: "/tmp/pa-root",
			installRoot: "/tmp/pa-root",
			dbPath: ":memory:",
			sessionDir: "/tmp/pa-root/.data/pi-sessions",
			workspaceNames: [],
			businessRoleIds: ["product-manager"],
			hasArchitectRole: false,
			extensionNames: ["worker-runtime"],
			extraPiExtensions: ["/opt/custom-ext.ts"],
		},
	});
	assert.match(team, /Personal Agent v0\.8\.0 \(team mode · auth required\)/);
	assert.match(team, /LAN URLs \(auth required\): http:\/\/192\.168\.50\.45:4310/);
	assert.match(team, /Pi CLI startup check failed: spawn pi ENOENT · Node v26\.10\.0 · Local Pi resources: isolated/);
	assert.match(team, /DB: :memory:/);
	assert.match(team, /PA_PI_EXTENSIONS: \/opt\/custom-ext\.ts/);
});
