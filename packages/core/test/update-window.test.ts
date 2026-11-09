import { describe, expect, it } from 'vitest';
import { UpdateService } from '../src/updates/update-service';

describe('maintenance window', () => {
  const at = (h: number, m: number) => new Date(2026, 0, 1, h, m);
  it.each([
    ['03:00', at(3, 0), true],
    ['03:00', at(3, 59), true],
    ['03:00', at(4, 0), false],
    ['03:00', at(2, 59), false],
    ['23:30', at(0, 15), true],
    ['23:30', at(0, 31), false],
  ])('%s contains %s: %s', (window, now, expected) => expect(UpdateService.inWindow(window, now)).toBe(expected));
});
