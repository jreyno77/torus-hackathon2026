import { expect, test } from '@playwright/test';
import { FleetFlow } from './fleet-flow';

test.use({ actionTimeout: 5_000 });

test('the normal application advances the live-input fleet with execution clearly modeled', async ({ page }) => {
  const fleet = new FleetFlow(page);
  await fleet.open();
  await fleet.expectModeledExecution();
  await expect(page.getByText('1 simulated hour ≈ 3.8s', { exact: true })).toBeVisible();
  expect(await fleet.modelHour()).toBe(0);
  await fleet.letPlaybackAdvance(7_000);
  expect(await fleet.modelHour()).toBeGreaterThan(0);
  const evidence = await fleet.evidence();
  expect(evidence.selected.run.simulated).toBe(true);
  expect(evidence.selected.run.ticks.length).toBeGreaterThan(0);
});

test('fleet event details stay hidden until a job is clicked', async ({ page }) => {
  const fleet = new FleetFlow(page);
  await fleet.open();
  await fleet.pause();
  await fleet.step();
  const panel = page.getByRole('region', { name: 'Live input fleet', exact: true });
  await panel.getByRole('button', { name: 'Close controls', exact: true }).click();
  await expect(panel.locator('.fleet-stage > .fleet-decision')).toHaveCount(0);
  await fleet.expectNoHoverPopup('Salt Lake City');
  await panel.locator('summary').filter({ hasText: 'Inspect jobs' }).click();
  await panel.getByRole('button', { name: 'Inspect work-01', exact: true }).click();
  const job = panel.getByRole('region', { name: 'Job activity', exact: true });
  await expect(job).toBeVisible();
  await expect(job.locator('.fleet-decision')).toBeVisible();
});

test('zooming from Utah to the US and back preserves the running fleet and inspected location', async ({ page }) => {
  const fleet = new FleetFlow(page);
  await fleet.open();
  await fleet.pause();
  await fleet.step();
  await fleet.inspectLocation('Salt Lake City');
  expect((await fleet.currentLocation()).locationId).toBe('A');
  await fleet.inspectDataCenter('Meta Eagle Mountain, Utah');
  await fleet.expectDataCenterSource('meta-eagle-mountain', 'https://datacenters.atmeta.com/2026/09/deepening-our-investment-in-eagle-mountain-utah/', 1);
  await fleet.inspectLocation('Salt Lake City');
  expect((await fleet.currentLocation()).locationId).toBe('A');
  await fleet.showGeography('Explore Utah');
  await fleet.expectNoHoverPopup('Salt Lake City');
  await fleet.inspectLocation('Salt Lake City');
  const location = await fleet.currentLocation();
  const before = await fleet.evidence();
  expect(location.locationId).toBe('A');
  expect(before.hour).toBe(1);
  expect(before.selected.run.ticks).toHaveLength(1);
  expect(before.selected.run.ticks[0].executions.length).toBeGreaterThan(0);

  await fleet.showGeography('Show US');
  await fleet.expectAdmissionOnMap('work-01');
  expect(await fleet.currentLocation()).toEqual(location);
  expect(await fleet.modelHour()).toBe(1);
  await fleet.showGeography('Explore Utah');
  expect(await fleet.currentLocation()).toEqual(location);
  const after = await fleet.evidence();
  expect(after.hour).toBe(before.hour);
  expect(after.selected).toEqual(before.selected);
  expect(after.baseline).toEqual(before.baseline);
  await fleet.expectModeledExecution();
});

test('the open location detail advances with calculated job receipts and modeled energy', async ({ page }) => {
  const fleet = new FleetFlow(page);
  await fleet.open();
  await fleet.pause();
  await fleet.showGeography('Explore Utah');
  await fleet.inspectLocation('Salt Lake City');
  const initial = await fleet.currentLocation();
  // Original Open-Meteo forecast: 518 W/m² for17–18UTC. Declared8kW ×0.8 array model =3.3152kW.
  expect(initial.locationId).toBe('A');
  expect(initial.solarKW).toBeCloseTo(3.3152, 2);
  expect(initial.computeKWh).toBeNull();

  await fleet.step();
  const current = await fleet.currentLocation();
  const evidence = await fleet.evidence();
  const meter = evidence.selected.run.ticks[0].meters.find(item => item.locationId === 'A')!;
  expect(meter).toBeDefined();
  expect(evidence.selected.run.ticks[0].executions.some(item => item.completedGpuH > 0)).toBe(true);
  expect(current.locationId).toBe('A');
  expect(current.hour).toBe(1);
  expect(current.computeKWh).toBeCloseTo(meter.computeKWh, 2);
  expect(current.storedKWh).toBeCloseTo(meter.endingStoredKWh, 2);
  expect(current.storedKWh).not.toBe(initial.storedKWh);
  const execution = evidence.selected.run.ticks[0].executions.find(item => item.completedGpuH > 0)!;
  const job = evidence.selected.finalJobs.find(item => item.id === execution.jobId)!;
  expect(job).toBeDefined();
  expect(evidence.selected.run.ticks[0].executions).toContainEqual(expect.objectContaining({ jobId: job.id }));
  await fleet.expectJobState(job.id, job.state);
});

test('a solar disruption changes the next modeled receipt while preserving the captured forecast', async ({ page }) => {
  const fleet = new FleetFlow(page);
  await fleet.open();
  await fleet.pause();
  await fleet.step();
  const before = await fleet.evidence();
  const saltLake = before.scenario.sites.find(site => site.configuration.locationId === 'A')!;
  // Original forecast for18–19UTC is593W/m²; the declared array model supplies3.7952kW.
  expect(saltLake.forecast[1].supply?.solarKW).toBeCloseTo(3.7952, 10);

  await fleet.dropSolarAt('A');
  await fleet.step();
  const after = await fleet.evidence();
  expect(after.hour).toBe(2);
  expect(after.selected.run.ticks[1].meters.find(item => item.locationId === 'A')?.solarKWh).toBe(0);
  expect(after.baseline.run.ticks[1].meters.find(item => item.locationId === 'A')?.solarKWh).toBe(0);
  expect(after.scenario.events).toHaveLength(1);
  expect(after.scenario.sites.find(site => site.configuration.locationId === 'A')?.forecast).toEqual(saltLake.forecast);
  expect(after.selected.run.ticks[0]).toEqual(before.selected.run.ticks[0]);
});

test('unavailable weather leaves the fleet unavailable without invented jobs', async ({ page }) => {
  const fleet = new FleetFlow(page);
  await fleet.open({ weatherUnavailable: true });
  await fleet.expectModeledExecution();
  await fleet.expectWeatherUnavailable();
});

test('a documented data-center marker remains an explicitly simulated source as its arrivals increase', async ({ page }) => {
  const fleet = new FleetFlow(page);
  await fleet.open();
  await fleet.pause();
  await fleet.showGeography('Explore Utah');
  await fleet.step();
  await fleet.inspectDataCenter('Meta Eagle Mountain, Utah');
  const source = 'https://datacenters.atmeta.com/2026/09/deepening-our-investment-in-eagle-mountain-utah/';
  await fleet.expectDataCenterSource('meta-eagle-mountain', source, 1);
  await fleet.step();
  await fleet.expectDataCenterSource('meta-eagle-mountain', source, 2);
  await fleet.expectAdmissionOnMap('work-01');
  const evidence = await fleet.evidence();
  expect(evidence.jobOrigins.find(origin => origin.jobId === 'work-01')).toMatchObject({
    id: 'meta-eagle-mountain', jobId: 'work-01', simulated: true, kind: 'modeled-job-origin',
    locationAccuracy: 'city reference', sourceUrl: source,
    label: 'Simulated job source; no facility workload connection',
  });
});

test('a calculated cross-site transfer is inspectable on the map through its own job receipt', async ({ page }) => {
  const fleet = new FleetFlow(page);
  await fleet.open();
  await fleet.pause();
  let evidence = await fleet.evidence();
  // The public capture drives the policy; observe the first genuine transfer within its captured horizon.
  // This checks the UI handoff, while component examples prove the chooser against literal alternatives.
  for (let hour = 0; hour < evidence.scenario.hours && evidence.selected.run.transfers.length === 0; hour++) {
    await fleet.step();
    evidence = await fleet.evidence();
  }
  const transfer = evidence.selected.run.transfers.at(-1);
  expect(transfer).toBeDefined();
  expect(transfer!.fromLocation).not.toBe(transfer!.toLocation);
  expect(evidence.selected.finalJobs.some(job => job.id === transfer!.jobId)).toBe(true);
  await fleet.showGeography('Show US');
  await fleet.inspectTransferOnMap(transfer!.id, transfer!.jobId);
});

test('a frozen public-input moment survives disruption, storage retrieval and reload without current feeds', async ({ page }) => {
  const fleet = new FleetFlow(page);
  await fleet.open();
  await fleet.pause();
  await fleet.step();
  await fleet.step();
  const before = await fleet.evidence();
  expect(before.hour).toBe(2);
  expect(before.scenario.events ?? []).toHaveLength(0);
  expect(before.selected.run.ticks).toHaveLength(2);
  const saved = await fleet.saveFrozenMoment();
  expect(saved.capture.progress).not.toHaveProperty('map');
  expect(saved.capture.runInputs.weather?.snapshot.retrievedAt).toBe('2026-10-28T16:21:26.334Z');
  expect(saved.capture.runInputs.caiso?.revision).toBe('7e55fed62e260bfd0cf7d94af18e965ffa2cb27263a632bcda8e4f3ffdb5c70f');
  expect(saved.capture.progress).toMatchObject({
    hour: 2, phase: before.phase, scenario: before.scenario, selected: before.selected, baseline: before.baseline,
  });

  expect(await fleet.retrieveFrozenMoment(saved.revision, 2)).toEqual(saved);
  await fleet.expectPausedAt(2);
  await fleet.dropSolarAt('A');
  await fleet.step();
  const stressed = await fleet.evidence();
  expect(stressed.hour).toBe(3);
  expect(stressed.scenario.events).toHaveLength(1);
  expect(stressed.selected.run.ticks[2].meters.find(meter => meter.locationId === 'A')?.solarKWh).toBe(0);
  expect(stressed.selected.run.ticks.slice(0, 2)).toEqual(before.selected.run.ticks);

  expect(await fleet.restoreFrozenMoment(saved.revision, 2)).toEqual(saved);
  expect(await fleet.evidence()).toMatchObject({
    hour: 2, phase: before.phase, scenario: before.scenario, selected: before.selected, baseline: before.baseline,
    jobOrigins: before.jobOrigins,
  });
  await fleet.expectPausedAt(2);

  expect(await fleet.reloadFrozenMomentWithoutCurrentFeeds(saved.revision, 2)).toEqual(saved);
  expect(await fleet.evidence()).toMatchObject({
    hour: 2, phase: before.phase, scenario: before.scenario, selected: before.selected, baseline: before.baseline,
    jobOrigins: before.jobOrigins,
  });
  await fleet.expectPausedAt(2);
});
