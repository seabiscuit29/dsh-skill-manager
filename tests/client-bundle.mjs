// Client-bundle smoke test: executes the browser half in Node with a stub module
// loader, so a broken bundle is caught BEFORE it reaches the browser.
//
// Why this exists: the host half is covered by tests/smoke.mjs, but nothing
// executed lib/client.js. A missing `module`/`exports` preamble (or any other
// module-scope typo) only surfaced after a dsh web restart, as
//   Failed to load plugins — failed to import loader entry … (dsh-skill-manager):
//   exports is not defined
// This test reproduces exactly that class of failure.
//
// Usage: node tests/client-bundle.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const clientRel = pkg.exports?.["./client"]?.default ?? "./lib/client.js";
const clientFile = join(packageDir, clientRel);

let passed = 0;
let failed = 0;
/** One assertion with a readable report line. */
function check(label, condition, detail = "") {
	if (condition) {
		passed += 1;
		console.log(`  ok   ${label}`);
		return;
	}
	failed += 1;
	console.log(`  FAIL ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

// ---------------------------------------------------------------- stub runtime
/** Seeds consumed by the first N useState calls, so a render can start in a ready state. */
let stateSeeds = null;
/** Minimal React stand-in: enough to define components and run one render pass. */
const reactStub = {
	useState: (initial) => {
		const fallback = typeof initial === "function" ? initial() : initial;
		if (stateSeeds !== null && stateSeeds.length > 0) return [stateSeeds.shift(), () => {}];
		return [fallback, () => {}];
	},
	useEffect: () => {},
	useMemo: (factory) => factory(),
	useCallback: (fn) => fn,
	useRef: (value) => ({ current: value }),
	createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
	Fragment: Symbol("Fragment"),
};
const jsxRuntimeStub = {
	jsx: (type, props, key) => ({ type, props, key }),
	jsxs: (type, props, key) => ({ type, props, key }),
	Fragment: Symbol("Fragment"),
};
const primitivesStub = {
	IconChevronDownOutline14: (props) => ({ type: "chevron", props }),
};

/** Captured module descriptor from the loader shim. */
let captured;
globalThis.window = {
	__ModuleLoader__: {
		load: (descriptor) => {
			captured = descriptor;
		},
	},
};

// The bundle also guards CSS injection on `document`; leaving it undefined keeps
// the test DOM-free while still exercising the module body.
globalThis.document = undefined;

console.log(`bundle: ${clientRel}`);

// ---------------------------------------------------------------- 1. load file
try {
	await import(pathToFileURL(clientFile).href);
} catch (error) {
	check("bundle file evaluates (loader registration)", false, error.message);
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(1);
}
check("bundle registers itself with __ModuleLoader__", captured !== undefined);
check("descriptor declares an id", typeof captured?.id === "string", JSON.stringify(captured?.id));
check("descriptor id equals the package name", captured?.id === pkg.name, `${captured?.id} vs ${pkg.name}`);
check("descriptor exposes a factory", typeof captured?.factory === "function");

// ---------------------------------------------------------------- 2. run factory
let exportsValue;
const required = [];
const fakeRequire = (specifier) => {
	required.push(specifier);
	if (specifier === "react") return reactStub;
	if (specifier === "react/jsx-runtime") return jsxRuntimeStub;
	if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
	throw new Error(`unexpected require("${specifier}")`);
};
try {
	exportsValue = captured.factory(fakeRequire);
} catch (error) {
	check("factory executes without throwing", false, `${error.constructor.name}: ${error.message}`);
	console.log(`\n${passed} passed, ${failed} failed`);
	console.log("This is the failure mode that breaks the Settings - Skills page after a restart.");
	process.exit(1);
}
check("factory executes without throwing", true);
check("factory returns an exports object", exportsValue !== undefined && typeof exportsValue === "object");
check("exports.apply is callable", typeof exportsValue?.apply === "function");
check("exports.inject is an array", Array.isArray(exportsValue?.inject));
check(
	"only base-seed modules were required",
	required.every((specifier) => ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"].includes(specifier)),
	required.join(", "),
);

// ---------------------------------------------------------------- 3. run apply()
const registrations = [];
const dictionaries = [];
const ctxStub = {
	effect: (callback) => {
		callback();
	},
	locale: {
		register: (namespace, dicts) => {
			dictionaries.push({ namespace, dicts });
		},
		bind: () => (key) => key,
	},
	slots: {
		inject: (slotName, callback) => {
			callback();
			return () => {};
		},
		register: (descriptor, component) => {
			registrations.push({ descriptor, component });
			return () => {};
		},
	},
};
try {
	exportsValue.apply(ctxStub);
	check("apply() runs against a stub client context", true);
} catch (error) {
	check("apply() runs against a stub client context", false, `${error.constructor.name}: ${error.message}`);
}

const section = registrations.find((entry) => entry.descriptor?.name === "settings.section");
check("registers a settings.section", section !== undefined);
check("section id is the existing Skills seat", section?.descriptor?.id === "skills", String(section?.descriptor?.id));
check("section order is 16", section?.descriptor?.order === 16, String(section?.descriptor?.order));
check("dictionaries registered for the namespace", dictionaries.length > 0);
check(
	"zh and en dictionaries both present",
	dictionaries.some((entry) => entry.dicts?.zh !== undefined && entry.dicts?.en !== undefined),
);
check(
	"zh and en have the same keys",
	(() => {
		const dicts = dictionaries[0]?.dicts;
		if (dicts?.zh === undefined || dicts?.en === undefined) return false;
		const zh = Object.keys(dicts.zh).sort().join(",");
		const en = Object.keys(dicts.en).sort().join(",");
		return zh === en;
	})(),
);

// ---------------------------------------------------------------- 4. render once
// Catches render-path typos (the component body runs end to end with stub hooks).
if (section !== undefined) {
	try {
		const tree = section.component({ t: (key) => key });
		check("component renders without throwing", tree !== undefined);
	} catch (error) {
		check("component renders without throwing", false, `${error.constructor.name}: ${error.message}`);
	}
}

// ------------------------------------------------- 5. control semantics (regression)
// A checked checkbox next to the label "disable" reads backwards: it looks like
// "disabled is on" while the skill is actually enabled. The control must therefore
// state the CURRENT state as text and offer the ACTION as a button label.
/** Collect every node in a rendered tree matching a predicate. */
function collect(node, predicate, out = []) {
	if (node === null || node === undefined) return out;
	if (Array.isArray(node)) {
		for (const child of node) collect(child, predicate, out);
		return out;
	}
	if (typeof node !== "object") return out;
	if (predicate(node)) out.push(node);
	collect(node.props?.children, predicate, out);
	return out;
}

if (section !== undefined) {
	/** One row fixture carrying the fields the card reads. */
	const row = (name, state) => ({
		name,
		diskName: name,
		form: "bundle",
		description: `${name} description`,
		whenToUse: undefined,
		invocation: { modelInvocable: true, userInvocable: true },
		valid: true,
		state,
		tracked: true,
		managed: true,
		source: `github:example/repo#main/skills/${name}`,
		ref: "0123456789abcdef",
		path: `C:/tmp/${name}`,
		notes: [],
	});
	stateSeeds = [{ status: "ready", rows: [row("alpha-on", "enabled"), row("beta-off", "disabled")] }];
	const tree = section.component({ t: (key) => key });
	stateSeeds = null;

	const cards = collect(tree, (node) => node.props?.["data-skill"] !== undefined);
	check("both rows render as cards", cards.length === 2, String(cards.length));

	const onCard = cards.find((node) => node.props["data-skill"] === "alpha-on");
	const offCard = cards.find((node) => node.props["data-skill"] === "beta-off");
	const textsOf = (card) =>
		collect(card, (node) => typeof node.props?.children === "string").map((node) => node.props.children);
	const labelsOf = (card) =>
		collect(card, (node) => node.type === "button").map((node) => node.props.children);

	check("an enabled card renders no checkbox control", collect(onCard, (node) => node.type === "input").length === 0);
	check("enabled card states the current state", textsOf(onCard).includes("stateEnabled"));
	check("enabled card offers the disable ACTION as its button label", labelsOf(onCard).includes("disable"));
	check("enabled card never reads as disabled", !textsOf(onCard).includes("stateDisabled"));

	check("disabled card states the current state", textsOf(offCard).includes("stateDisabled"));
	check("disabled card offers the enable ACTION as its button label", labelsOf(offCard).includes("enable"));
	check("disabled card never reads as enabled", !textsOf(offCard).includes("stateEnabled"));

	// A row published from another root cannot be disabled or removed here, but it
	// can be migrated into the managed root — the only write action it may offer.
	stateSeeds = [
		{
			status: "ready",
			rows: [
				{
					...row("gamma-elsewhere", "enabled"),
					managed: false,
					tracked: false,
					providerSource: "user-agents",
				},
			],
		},
	];
	const outsideTree = section.component({ t: (key) => key });
	stateSeeds = null;
	const outsideCard = collect(outsideTree, (node) => node.props?.["data-skill"] !== undefined)[0];
	const outsideTexts = textsOf(outsideCard);
	const outsideLabels = labelsOf(outsideCard);
	check("an other-root card states it is read-only here", outsideTexts.includes("notManaged"));
	check("an other-root card offers the migrate ACTION", outsideLabels.includes("migrate"));
	check("an other-root card offers no remove action", !outsideLabels.includes("remove"));
	check("an other-root card offers no enable/disable action", !outsideLabels.includes("enable") && !outsideLabels.includes("disable"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
