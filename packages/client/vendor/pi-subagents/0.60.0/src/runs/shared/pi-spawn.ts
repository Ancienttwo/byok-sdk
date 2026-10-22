import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

export function findPiPackageRootFromEntry(
	entryPoint: string,
): string | undefined {
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
				name?: unknown;
			};
			if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

// SDK delta: find the first node_modules package directory in this module's
// ancestor chain, skipping a non-directory, as ESM resolution does. CommonJS bundles have no
// import.meta.resolve (#724).
export function resolveInstalledPiPackageRoot(): string | undefined {
	for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", PI_CODING_AGENT_PACKAGE);
		if (fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) return findPiPackageRootFromEntry(path.join(fs.realpathSync(candidate), "package.json"));
		if (path.dirname(dir) === dir) throw new Error(`Cannot find package '${PI_CODING_AGENT_PACKAGE}'`);
	}
}

export function resolvePiPackageRoot(): string | undefined {
	try {
		const entry = process.argv[1];
		return entry
			? findPiPackageRootFromEntry(fs.realpathSync(entry))
			: undefined;
	} catch {
		// process.argv[1] probing is best-effort; callers can fall back to PATH/package resolution.
		return undefined;
	}
}
