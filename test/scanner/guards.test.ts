import { describe, expect, it } from 'vitest';

import { guardPatternMatches } from '../../src/core/scanner';
import { guardHits } from '../../src/core/scannerGuards';

describe('guardPatternMatches', () => {
  it('matches a substring, whatever the case', () => {
    expect(guardPatternMatches('ffmpeg', 'ffmpeg')).toBe(true);
    expect(guardPatternMatches('mpe', 'ffmpeg')).toBe(true);
    expect(guardPatternMatches('FFmpeg', 'ffmpeg')).toBe(true);
    expect(guardPatternMatches('ffmpeg', 'FFMPEG')).toBe(true);
    expect(guardPatternMatches('  ffmpeg  ', 'ffmpeg')).toBe(true);
  });

  it('does not match an unrelated name', () => {
    expect(guardPatternMatches('blender', 'ffmpeg')).toBe(false);
    expect(guardPatternMatches('ffmpeg2', 'ffmpeg')).toBe(false);
  });

  it("matches 'ffmpeg.exe' against the name 'ffmpeg' the process list reports", () => {
    expect(guardPatternMatches('ffmpeg.exe', 'ffmpeg')).toBe(true);
    expect(guardPatternMatches('FFMPEG.EXE', 'ffmpeg')).toBe(true);
  });

  it('matches a name that still carries its extension', () => {
    expect(guardPatternMatches('^ffmpeg$', 'ffmpeg.exe')).toBe(true);
    expect(guardPatternMatches('ffmpeg.exe', 'ffmpeg.exe')).toBe(true);
  });

  it('matches a glob', () => {
    expect(guardPatternMatches('ffm*', 'ffmpeg')).toBe(true);
    expect(guardPatternMatches('ff?peg', 'ffmpeg')).toBe(true);
    expect(guardPatternMatches('*.exe', 'ffmpeg')).toBe(true);
    expect(guardPatternMatches('blender-*', 'blender-softwaregl')).toBe(true);
    expect(guardPatternMatches('ff?peg?.exe', 'ffmpeg')).toBe(false);
  });

  it("matches 'ffmpeg*', which as a regex alone would mean something else", () => {
    expect(guardPatternMatches('handbrake*', 'handbrakecli')).toBe(true);
    expect(guardPatternMatches('c++*', 'c++filt')).toBe(true);
  });

  it('matches a regex', () => {
    expect(guardPatternMatches('^ff.*g$', 'ffmpeg')).toBe(true);
    expect(guardPatternMatches('.*mpeg\\.exe', 'ffmpeg')).toBe(true);
    expect(guardPatternMatches('^(robocopy|rsync)$', 'rsync')).toBe(true);
    expect(guardPatternMatches('^(robocopy|rsync)$', 'rsyncd')).toBe(false);
    expect(guardPatternMatches('python3\\.\\d+', 'python3.12')).toBe(true);
  });

  it('keeps the case of regex escapes', () => {
    expect(guardPatternMatches('node\\S', 'nodejs')).toBe(true);
    expect(guardPatternMatches('^\\D+$', 'python3')).toBe(false);
  });

  it('treats an invalid regex as no regex match instead of throwing', () => {
    expect(guardPatternMatches('ffmpeg[', 'ffmpeg')).toBe(false);
    expect(guardPatternMatches('(', 'ffmpeg')).toBe(false);
    expect(guardPatternMatches('*', 'ffmpeg')).toBe(true);
    expect(guardPatternMatches('[', 'weird[name')).toBe(true);
  });

  it('never matches an empty pattern', () => {
    expect(guardPatternMatches('', 'ffmpeg')).toBe(false);
    expect(guardPatternMatches('   ', 'ffmpeg')).toBe(false);
    expect(guardPatternMatches('', '')).toBe(false);
  });

  it('does not throw on values of the wrong type', () => {
    expect(guardPatternMatches(undefined as unknown as string, 'ffmpeg')).toBe(false);
    expect(guardPatternMatches('ffmpeg', null as unknown as string)).toBe(false);
  });
});

describe('guardHits', () => {
  const processes = [
    { pid: 1, ppid: 0, name: 'ffmpeg' },
    { pid: 2, ppid: 0, name: 'code' },
    { pid: 3, ppid: 0, name: 'ffmpeg' },
    { pid: 4, ppid: 0, name: 'blender' },
  ];

  it('is null when the process list could not be read, with or without patterns', () => {
    expect(guardHits(['ffmpeg'], null)).toBeNull();
    expect(guardHits([], null)).toBeNull();
  });

  it('lists each matching name once, sorted', () => {
    expect(guardHits(['ffmpeg.exe', 'blend*'], processes)).toEqual(['blender', 'ffmpeg']);
  });

  it('is empty when nothing matches or nothing is asked for', () => {
    expect(guardHits(['handbrake'], processes)).toEqual([]);
    expect(guardHits([], processes)).toEqual([]);
    expect(guardHits([''], processes)).toEqual([]);
  });
});
