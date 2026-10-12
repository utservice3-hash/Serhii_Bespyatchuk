/**
 * Паритет: shared/cargoEngine.ts = рушій затвердженого макета v2.
 * 1) 40 названих сценаріїв — порівняння з еталоном engine-ref.json (знятий tools/captureEngineRef.ts з макета);
 * 2) 60 випадкових сценаріїв (фіксоване зерно) — живе порівняння з tests/fixtures/mockup-v2-engine.cjs.
 * Порівнюється все, що бачить менеджер: позиція кожного місця, що не влізло, насипом, варіанти, «ще влізе», вільно, вага.
 */
import { describe, expect, it } from './shim.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as TS from '../cargoEngine.js';
import { randomScenario, runScenario, type EngineLike, type Scenario } from './engineHarness.js';

// [дашборд] фікстури лежать у src (тести біжать із dist): єдина зміна тіла, крім імпортів
const dir = join(import.meta.dirname, '..', '..', '..', 'src', 'cargo', 'fixtures');
const scenarios = JSON.parse(readFileSync(join(dir, 'scenarios.json'), 'utf8')) as Scenario[];
const ref = JSON.parse(readFileSync(join(dir, 'engine-ref.json'), 'utf8')).scenarios as Record<string, unknown>;
const Mock = createRequire(import.meta.filename)(join(dir, 'mockup-v2-engine.cjs')) as EngineLike;

describe('рушій TS = макет v2: еталонні сценарії', () => {
  it('еталон покриває всі сценарії', () => { expect(Object.keys(ref).sort()).toEqual(scenarios.map(s => s.key).sort()); });
  for (const s of scenarios) {
    it(`${s.key}${s.note ? ' — ' + s.note : ''}`, () => {
      expect(runScenario(TS, s)).toEqual(ref[s.key]);
    });
  }
});

describe('рушій TS = макет v2: випадкові сценарії', () => {
  for (let seed = 1; seed <= 60; seed++) {
    it(`зерно ${seed}`, () => {
      const s = randomScenario(seed);
      expect(runScenario(TS, s)).toEqual(runScenario(Mock, s));
    });
  }
});
