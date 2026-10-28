import { expect, test } from '@playwright/test';
import { FleetActivityFlow } from './fleet-activity-flow';

test.use({ actionTimeout: 5_000 });

test('nearby arrivals use brief source and destination pulses without icons, floating labels or persistent routes', async ({ page }) => {
  await page.setViewportSize({ width: 920, height: 850 });
  const fleet = new FleetActivityFlow(page);
  await fleet.open();
  await fleet.pause();
  await fleet.startNextHour();
  await fleet.expectSubmission('work-01', 'Meta Eagle Mountain, Utah', 'Salt Lake City');
  await fleet.expectNoPersistentClutter();
  await fleet.letPlaybackAdvance(900);
  await fleet.expectArrival('work-01', 'Salt Lake City');
  await fleet.letPlaybackAdvance(500);
  await fleet.expectSubmissionExpired('work-01');
});

test('on a phone activity cues leave site dots clickable and their empty margin stays map space', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fleet = new FleetActivityFlow(page);
  await fleet.open();
  await fleet.pause();
  await fleet.step();
  await fleet.showGeography('Explore Utah');
  await fleet.expectEmptyMarkerMarginToStayMapSpace();
  await fleet.inspectPaintedSaltLake();
});

test('one paused Step shows departure then arrival, keeps the dot clickable, and clears feedback after 1.4 seconds', async ({ page }) => {
  const fleet = new FleetActivityFlow(page);
  await fleet.open();
  await fleet.pause();
  await fleet.setPlaybackSpeed(1);
  await fleet.showGeography('Explore Utah');
  await fleet.startNextHour();
  await fleet.expectSubmission('work-01', 'Meta Eagle Mountain, Utah', 'Salt Lake City');
  await fleet.expectFeedbackPassesPointersThrough();
  await fleet.inspectPaintedSaltLake();
  await fleet.letPlaybackAdvance(900);
  await fleet.expectArrival('work-01', 'Salt Lake City');
  await fleet.letPlaybackAdvance(499);
  await fleet.expectArrival('work-01', 'Salt Lake City');
  // The visual cue ends before the 1.8s routed presentation settles the model hour.
  expect(await fleet.modelHour()).toBe(0);
  await fleet.letPlaybackAdvance(1);
  await fleet.expectSubmissionExpired('work-01');
  await fleet.letPlaybackAdvance(600);
  expect(await fleet.modelHour()).toBe(1);
  await fleet.letPlaybackAdvance(2_000);
  expect(await fleet.modelHour()).toBe(1);
});

test('four-times playback keeps the same brief wall-clock event lifetime', async ({ page }) => {
  const fleet = new FleetActivityFlow(page);
  await fleet.open();
  await fleet.pause();
  await fleet.setPlaybackSpeed(4);
  await fleet.showGeography('Explore Utah');
  await fleet.startNextHour();
  await fleet.expectSubmission('work-01', 'Meta Eagle Mountain, Utah', 'Salt Lake City');
  await fleet.letPlaybackAdvance(900);
  await fleet.expectArrival('work-01', 'Salt Lake City');
  await fleet.letPlaybackAdvance(499);
  await fleet.expectArrival('work-01', 'Salt Lake City');
  expect(await fleet.modelHour()).toBe(1);
  await fleet.letPlaybackAdvance(1);
  await fleet.expectSubmissionExpired('work-01');
});

test('reduced motion retains brief static endpoints with accessible provenance and no comet', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fleet = new FleetActivityFlow(page);
  await fleet.open();
  await fleet.pause();
  await fleet.showGeography('Explore Utah');
  await fleet.startNextHour();
  await fleet.expectSubmission('work-01', 'Meta Eagle Mountain, Utah', 'Salt Lake City');
  await fleet.expectStaticFeedback('work-01');
  await fleet.expectFeedbackPassesPointersThrough();
  await fleet.inspectPaintedSaltLake();
  await fleet.letPlaybackAdvance(1_399);
  await fleet.expectStaticFeedback('work-01');
  await fleet.letPlaybackAdvance(1);
  await fleet.expectSubmissionExpired('work-01');
});

test('restoring hour one keeps old events quiet, the next Step marks new arrivals, and Reset clears feedback at the saved baseline', async ({ page }) => {
  const fleet = new FleetActivityFlow(page);
  await fleet.open();
  await fleet.pause();
  await fleet.step();
  const baseline = await fleet.evidence();
  expect(baseline.hour).toBe(1);
  const saved = await fleet.saveFrozenMoment();
  await fleet.restoreFrozenMoment(saved.revision, 1);
  await fleet.expectNoEventFeedback();
  expect(await fleet.evidence()).toEqual(baseline);

  await fleet.showGeography('Show US');
  await fleet.startNextHour();
  // The real capture declares two jobs/hour; work-03 has home C and its catalog origin is Loudoun.
  await fleet.expectSubmission('work-03', 'Google Loudoun County, Virginia', 'Sacramento');
  await fleet.expectNoPersistentClutter();
  await fleet.letPlaybackAdvance(2_000);
  expect(await fleet.modelHour()).toBe(2);
  await fleet.resetToCaptured(1);
  await fleet.expectNoEventFeedback();
  expect(await fleet.evidence()).toEqual(baseline);
});
