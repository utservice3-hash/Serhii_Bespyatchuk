/**
 * КАНОНІЧНИЙ РАХУНОК ГЕЙТІВ. Один інструмент для всіх чатів — див. `testManifest.ts`.
 *
 *   node dist/tools/gateCount.js                     # скільки гейтів у цьому дереві
 *   node dist/tools/gateCount.js --base=<sha>        # порівняти з базою (напр. health.version)
 *
 * Друкує ІМЕНА, що зникли й додались, а не лише дельту: критерій приймання —
 * «не зникло нічого ЧУЖОГО», і його число не виражає.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { MANIFEST_TESTS, gateNames, diffGates } from "../testManifest.js";

/** Розбір маніфеста як ТЕКСТУ (для чужого коміту). Винесено, щоб гейт міг перевірити його без git. */
export function parseManifestTests(src: string, whence = "джерело"): string[] {
  const body = /export const MANIFEST_TESTS:[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src)?.[1];
  if (!body) throw new Error(`не знайшов MANIFEST_TESTS у ${whence} — розбір зламався, а не маніфест порожній`);
  // 🔴 Розекранувати ОБОВʼЯЗКОВО: `роз\'єднати` у джерелі — це `роз'єднати` в імені тесту.
  // Без цього той самий гейт читається як «зник» і «додався» одночасно (спіймано на #159c).
  return [...body.matchAll(/^\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) => m[1].replace(/\\(.)/g, "$1"));
}

/** Витягує список тестів із маніфеста ІНШОГО коміту — тим самим розбором, не своїм. */
export function testsAtRef(ref: string): string[] {
  return parseManifestTests(
    execFileSync("git", ["show", `${ref}:backend/src/testManifest.ts`], { encoding: "utf8" }), ref);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
const base = process.argv.find((a) => a.startsWith("--base="))?.slice(7);
if (!base) {
  console.log(`гейтів у дереві: ${gateNames().length}`);
} else {
  const d = diffGates(testsAtRef(base), MANIFEST_TESTS);
  console.log(`база ${base}: ${d.countBefore} · дерево: ${d.countAfter}`);
  console.log(d.onlyBefore.length
    ? `🔴 ЗНИКЛО ${d.onlyBefore.length}:\n  ` + d.onlyBefore.join("\n  ")
    : "✔ не зникло жодного");
  if (d.onlyAfter.length) console.log(`+ додано ${d.onlyAfter.length}:\n  ` + d.onlyAfter.join("\n  "));
  if (d.onlyBefore.length) process.exit(1);
}
}
