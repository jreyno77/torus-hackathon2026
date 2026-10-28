import { useEffect, useMemo, useState } from 'react';
import { createSiteWeatherClient } from '../../data/createSiteWeatherClient';
import { captureLiveFleet, type FleetCapture } from '../../data/captureLiveFleet';
import { dataCenters, originForJob } from '../../data/dataCenters';
import { modeledSites } from '../../data/modeledSites';
import type { FleetSourceBundle, FrozenFleetSnapshot } from '../../data/FrozenFleet.type';
import { saveFleetMoment, loadFleetMoment, type SavedFleetMoment } from '../../data/fleetMoments';
import { restoreFrozenFleet } from '../replay/restoreFrozenFleet';
import type { createPairedReplaySession } from '../../core/execution/replay/createPairedReplaySession';
import type { PublicGridClient } from '../../data/createPublicGridClient';
import { useFeed } from '../data/useFeed';
import { useReplayPlayback } from '../replay/useReplayPlayback';
import { FleetMap, type FleetSiteVisual } from './FleetMap';
import type { ReplayProgress } from '../../core/execution/replay/createPairedReplaySession';
import { SourceSignals } from './SourceSignals';
import { FleetSummary } from './FleetSummary';
import { FleetDecision, jobActivity } from './FleetDecision';
import { CapacityHorizon, MoveSignal } from './EngineSignals';
import { fleetCapacity } from './fleetCapacity';
import './LiveFleet.css';

const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const time = (value: string) => value.slice(11, 16) + ' UTC';
const fleetTickMs = 2000;
const fleetRoutedDwellMs = 1800;
const fleetSecondsPerHour = (fleetTickMs + fleetRoutedDwellMs) / 1000;
const unconnected: FleetSiteVisual[] = modeledSites.map(site => ({ ...site,
  ...fleetCapacity({ planPublished: false, kWPerGpu: .4, allocations: [] }),
  capacity: 8, solarKW: 0, storedKWh: 0, storageCapacityKWh: 0, activeJobs: 0, queuedJobs: 0 }));

export function LiveFleet({ grid }: { grid: PublicGridClient }) {
  const [weatherClient] = useState(() => createSiteWeatherClient());
  const weather = useFeed(weatherClient), market = useFeed(grid.caiso), eia = useFeed(grid.eia);
  const [now, setNow] = useState(Date.now);
  const [capture, setCapture] = useState<FleetCapture>();
  const [generation, setGeneration] = useState(0);
  const [freezeAnchor, setFreezeAnchor] = useState<SavedFleetMoment>();
  const [restored, setRestored] = useState<ReturnType<typeof createPairedReplaySession>>();
  const [requestedCapture] = useState(() => new URLSearchParams(location.search).get('capture'));
  const [loadingMoment, setLoadingMoment] = useState(Boolean(requestedCapture));
  const [loadError, setLoadError] = useState('');
  const [sourcePanelOpen, setSourcePanelOpen] = useState(false);
  const [momentId, setMomentId] = useState(requestedCapture ?? '');
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const candidate = useMemo(() => captureLiveFleet(weather, market, now), [weather, market, now]);
  useEffect(() => { if (!capture && !requestedCapture && candidate.available) setCapture(candidate.capture); }, [capture, candidate, requestedCapture]);
  const changed = capture && candidate.available && candidate.capture.scenario.inputRevision !== capture.scenario.inputRevision;
  function startLatest() {
    if (!candidate.available) return;
    setCapture(candidate.capture); setRestored(undefined); setFreezeAnchor(undefined); setMomentId(''); setLoadError('');
    setGeneration(value => value + 1);
    const url = new URL(location.href); url.searchParams.delete('capture'); history.replaceState(null, '', url);
  }
  async function restoreSaved(saved: SavedFleetMoment) {
    const session = await restoreFrozenFleet(saved.capture);
    const sources = saved.capture.runInputs;
    if (!sources.weather || !sources.caiso) throw new Error('Frozen moment is missing its original public inputs.');
    const price = sources.caiso.snapshot.prices.filter(point => Date.parse(point.window.startAt) <= Date.parse(sources.capturedAt)).at(-1);
    if (!price) throw new Error('Frozen moment has no original reference market price.');
    setCapture({ scenario: saved.capture.progress.scenario, runInputs: sources, weatherRevision: sources.weather.revision,
      priceRevision: sources.caiso.revision, capturedAt: sources.capturedAt, price });
    setRestored(session); setFreezeAnchor(saved); setGeneration(value => value + 1); setMomentId(saved.revision); setLoadError('');
    const url = new URL(location.href); url.searchParams.set('capture', saved.revision); history.replaceState(null, '', url);
  }
  useEffect(() => {
    if (!requestedCapture) return;
    let active = true;
    void loadFleetMoment(requestedCapture).then(async saved => { if (active) await restoreSaved(saved); })
      .catch(error => { if (active) setLoadError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (active) setLoadingMoment(false); });
    return () => { active = false; };
  }, [requestedCapture]);
  async function retrieveMoment() {
    if (loadingMoment) return;
    setLoadingMoment(true);
    setLoadError('');
    try { await restoreSaved(await loadFleetMoment(momentId)); }
    catch (error) { setLoadError(error instanceof Error ? error.message : String(error)); }
    finally { setLoadingMoment(false); }
  }
  function latestSources(): FleetSourceBundle {
    const publication = <T,>(feed: { getSnapshot(): { snapshot: T | null; revision: string | null; status: string } }) => {
      const state = feed.getSnapshot();
      return state.snapshot && state.revision ? { revision: state.revision, snapshot: structuredClone(state.snapshot),
        status: state.status === 'ready' ? 'ready' as const : 'stale' as const } : null;
    };
    return { capturedAt: new Date().toISOString(), weather: publication(weatherClient), caiso: publication(grid.caiso), eia: publication(grid.eia) };
  }
  return <section className="live-fleet" aria-label="Live input fleet">
    <div className="fleet-heading"><div className="fleet-heading-label"><h2>24-hour fleet</h2><span className="fleet-mode">Modeled execution</span></div>
      <SourceSignals onOpenChange={setSourcePanelOpen} weather={weather} market={market} eia={eia} capture={capture} now={now} onRefresh={() => Promise.allSettled([weatherClient.refresh(), grid.caiso.refresh(), grid.eia.refresh()])} />
    </div>
    {capture?.runInputs.caiso?.status === 'stale' && <p className="fleet-source-notice" role="status">
      This run uses the captured CAISO price. It met the one-hour age limit at capture, when refreshing was delayed.
    </p>}
    {capture ? <FleetSession key={generation} sourcePanelOpen={sourcePanelOpen} capture={capture} restored={restored} freezeAnchor={freezeAnchor} latestSources={latestSources} onRestore={restoreSaved} /> : <>
      <FleetMap sites={unconnected} transfers={[]} playing={false} onInspect={() => {}} onJob={() => {}} />
      <p className="fleet-empty" role="status">{loadingMoment ? 'Retrieving the frozen moment…' : loadError || (candidate.available ? 'Preparing the fleet…' : candidate.reason)}</p>
      {loadError && !loadingMoment && <div className="fleet-new-input">
        <span>The saved moment was not restored. Its archived record is unchanged.</span>
        <button disabled={!candidate.available} onClick={startLatest}>Start a new run with latest inputs</button>
        {!candidate.available && <small>{candidate.reason}</small>}
      </div>}
    </>}
    {changed && <div className="fleet-new-input"><span>New public inputs available</span><button onClick={startLatest}>Start with latest inputs</button></div>}
    <details className="fleet-provenance"><summary>Retrieve a frozen moment</summary>
      <form onSubmit={event => { event.preventDefault(); void retrieveMoment(); }}>
        <label>Capture ID <input aria-label="Frozen capture ID" value={momentId} onChange={event => setMomentId(event.target.value)} /></label>
        <button type="submit" disabled={loadingMoment}>Retrieve frozen moment</button>
      </form>
      <p>Paste the ID from Disrupt → Save frozen moment.</p>
      {loadError && <p role="alert">{loadError}</p>}<p>Retrieves the exact public input bundle and replays it to the saved paused state. New source readings stay separate.</p>
    </details>
    <details className="fleet-provenance"><summary>Sources & model assumptions</summary>
      <p><a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">Open-Meteo</a> supplies site-specific radiation forecasts; retrieved {weather.snapshot?.retrievedAt ?? 'unavailable'}.
        {' '}<a href="https://oasis.caiso.com" target="_blank" rel="noreferrer">CAISO</a> supplies a PACE reference wholesale price, not local tariffs for these six sites.
        {' '}<a href="https://www.eia.gov/opendata/" target="_blank" rel="noreferrer">EIA</a> demand is regional context, never spare site capacity.</p>
      <p>City markers are modeled compute sites with their own solar, grid connection and battery. Blue job-origin markers use public data-center locations as references only; all submitted jobs are generated by this simulation, not received from those operators. Each modeled compute site has 8 GPUs at 0.4 kW, an 8 kW solar array at 0.8 performance ratio,
        1.5 kW grid import, 0.2 kW fixed load and 2 kWh storage initially containing 0.6 kWh. Storage charge/discharge efficiency is 90% each.
        Solar is radiation × array size × performance ratio. Jobs are declared synthetic arrivals; transfers assume 1 GB/hour, 0.01 kWh/GB and $0.001/GB.</p>
      <p>All sites share the captured CAISO reference price throughout this 24-hour model. Carbon inputs are assumptions: grid 400 g/kWh, solar 40 g/kWh; carbon price is zero.
        Public inputs remain pinned to the displayed run. New captures can start a new run; zoom and inspection never reset it. No measured site power or remote GPU execution is claimed.</p>
      {capture && <p>Captured {capture.capturedAt}. Weather revision <code>{capture.weatherRevision}</code>. Price revision <code>{capture.priceRevision}</code>.
        Price ${number(capture.price.usdPerMWh)}/MWh · {time(capture.price.window.startAt)}–{time(capture.price.window.endAt)}.</p>}
      {!candidate.available && capture && <p role="status">Source freshness: {candidate.reason} This running model retains its original capture.</p>}
    </details>
  </section>;
}

function download(progress: ReplayProgress) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ ...progress, jobOrigins: progress.scenario.jobs.map(job => originForJob(job.id)) }, (_, value) => value instanceof Map ? Object.fromEntries(value) : value, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `fleet-${progress.hour}-evidence.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function nextSolarDisruption(progress: ReplayProgress, locationId: string) {
  const site = progress.scenario.sites.find(item => item.configuration.locationId === locationId);
  const atHour = site?.observations.findIndex((input, hour) => hour >= progress.hour && (input.supply?.solarKW ?? 0) > 0
    && !progress.scenario.events?.some(event => event.kind === 'solar-drop' && event.atHour === hour
      && (event.payload as { locationId: string }).locationId === locationId)) ?? -1;
  if (!site || atHour < 0 || progress.done) return undefined;
  const input = site.observations[atHour];
  return { atHour, solarKW: input.supply!.solarKW, startAt: input.window.startAt };
}
function FleetSession({ capture, restored, freezeAnchor, latestSources, onRestore, sourcePanelOpen }: {
  sourcePanelOpen: boolean; capture: FleetCapture; restored?: ReturnType<typeof createPairedReplaySession>; freezeAnchor?: SavedFleetMoment;
  latestSources: () => FleetSourceBundle; onRestore: (saved: SavedFleetMoment) => Promise<void>;
}) {
  const playback = useReplayPlayback(capture.scenario, { session: restored, autoPlay: !restored, tickMs: fleetTickMs, routedDwellMs: fleetRoutedDwellMs });
  const { progress, actions } = playback;
  const place = (id: string) => progress.scenario.sites.find(site => site.configuration.locationId === id)?.name ?? id;
  const [selected, setSelected] = useState<string>();
  const [jobId, setJobId] = useState<string>();
  const [originId, setOriginId] = useState<string>();
  const [monkey, setMonkey] = useState(false);
  const [eventSite, setEventSite] = useState('A');
  const [notice, setNotice] = useState('');
  const [activityEpoch, setActivityEpoch] = useState(0);
  const [savedMoment, setSavedMoment] = useState<SavedFleetMoment | undefined>(freezeAnchor);
  const [saving, setSaving] = useState(false);
  const [preparingDisruption, setPreparingDisruption] = useState(false);
  const latestDecision = progress.selected.decisions.at(-1);
  const displayHour = latestDecision?.hour ?? 0;
  const currentAt = new Date(Date.parse(progress.scenario.startAt) + displayHour * 3_600_000).toISOString();
  const currentTick = progress.selected.run.ticks.find(tick => tick.meters[0]?.window.startAt === currentAt);
  const currentPlan = progress.selected.plans?.findLast(plan => Date.parse(plan.asOf) === Date.parse(currentAt));
  const sites: FleetSiteVisual[] = progress.scenario.sites.map(definition => {
    const reference = { id: definition.configuration.locationId, name: definition.name ?? definition.configuration.locationId, latitude: definition.lat ?? NaN, longitude: definition.lng ?? NaN };
    const compute = definition.configuration.compute;
    const input = definition.observations[displayHour];
    const dropped = progress.scenario.events?.some(event => event.atHour === displayHour && (event.payload as { locationId: string }).locationId === reference.id);
    const snapshot = progress.map.sites.get(reference.id)?.slots.find(slot => slot.snapshot.slot?.window.startAt === currentAt)?.snapshot;
    const allocations = latestDecision?.results.filter(result => result.accepted && result.selection.selected && result.selection.allocation.slot.locationId === reference.id) ?? [];
    const capacity = fleetCapacity({ snapshot, planPublished: Boolean(progress.selected.plans?.length), kWPerGpu: compute.kWPerGpu,
      plan: currentPlan?.slots.find(slot => slot.locationId === reference.id && Date.parse(slot.window.startAt) === Date.parse(currentAt)),
      allocations: allocations.flatMap(result => result.selection.selected ? [result.selection.allocation] : []) });
    const meter = currentTick?.meters.find(meter => meter.locationId === reference.id);
    const priorMeter = progress.selected.run.ticks.flatMap(tick => tick.meters).findLast(meter => meter.locationId === reference.id);
    return { ...reference, ...capacity, capacity: compute.capGpus, storageCapacityKWh: definition.configuration.storage.limits.capacityKWh,
      solarKW: meter?.solarKWh ?? (dropped ? 0 : input.supply?.solarKW ?? 0),
      storedKWh: priorMeter?.endingStoredKWh ?? definition.configuration.storage.initial.storedKWh,
      activeJobs: progress.phase === 'routed' ? allocations.length : 0, queuedJobs: progress.selected.finalJobs.filter(job => job.currentLocation === reference.id && job.state === 'queued' && job.readyAt <= currentAt).length };
  });
  const origin = dataCenters.find(site => site.id === originId);
  const admissions = [...new Set(progress.selected.decisions.flatMap(decision => decision.results.map(result => result.jobId)))].map(jobId => ({ jobId, homeLocation: progress.scenario.jobs.find(job => job.id === jobId)!.homeLocation }));
  const active = sites.find(site => site.id === selected);
  const activeMeter = currentTick?.meters.find(meter => meter.locationId === selected);
  const job = progress.selected.finalJobs.find(job => job.id === jobId);
  const jobDecision = progress.selected.decisions.findLast(decision => decision.results.some(result => result.jobId === jobId));
  const jobChoice = jobDecision?.results.find(result => result.jobId === jobId);
  const movement = jobChoice?.selection.movement;
  const jobReceipts = progress.selected.run.ticks.flatMap(tick => tick.executions).filter(receipt => receipt.jobId === jobId);
  const arrived = progress.selected.finalJobs.filter(job => admissions.some(admission => admission.jobId === job.id));
  const disruptionOptions = progress.scenario.sites.map(site => ({
    id: site.configuration.locationId, name: site.name ?? site.configuration.locationId,
    next: nextSolarDisruption(progress, site.configuration.locationId),
  }));
  const disruption = disruptionOptions.find(option => option.id === eventSite)?.next;
  const failure = progress.selected.run.ticks.find(tick => !tick.feasible);
  function closeInspection() { setSelected(undefined); setJobId(undefined); setOriginId(undefined); }
  function inspect(id: string) { setMonkey(false); setOriginId(undefined); setSelected(id); setJobId(undefined); setEventSite(id); }
  function inspectJob(id: string) { setMonkey(false); setOriginId(undefined); setSelected(undefined); setJobId(id); }
  function inspectOrigin(id: string) { setMonkey(false); setJobId(undefined); setSelected(undefined); setOriginId(id); }
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') { closeInspection(); setMonkey(false); }
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);
  useEffect(() => {
    if (sourcePanelOpen) { closeInspection(); setMonkey(false); }
  }, [sourcePanelOpen]);
  const remainingSeconds = Math.ceil((progress.totalHours - progress.hour) * fleetSecondsPerHour / playback.speed);
  const timeToResult = Math.floor(remainingSeconds / 60) + 'm ' + remainingSeconds % 60 + 's';
  async function freezeMoment() {
    setSaving(true);
    try {
      await actions.pause();
      const { map: _derivedMap, ...frozenProgress } = playback.read();
      const snapshot: FrozenFleetSnapshot = { schemaVersion: 1, capturedAt: new Date().toISOString(),
        runInputs: capture.runInputs, latestContext: latestSources(), progress: frozenProgress };
      const saved = await saveFleetMoment(snapshot);
      setSavedMoment(saved); setNotice('Frozen moment saved. Stress tests use this run’s captured inputs; newer public readings remain separate.');
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }
  async function openDisruption() {
    if (monkey) { setMonkey(false); return; }
    setMonkey(true); setPreparingDisruption(true);
    try {
      await actions.pause();
      const settled = playback.read();
      const choices = settled.scenario.sites.map(site => ({ id: site.configuration.locationId,
        next: nextSolarDisruption(settled, site.configuration.locationId) }));
      const preferred = choices.filter(option => option.next).toSorted((a, b) =>
        a.next!.atHour - b.next!.atHour || b.next!.solarKW - a.next!.solarKW)[0];
      if (preferred) setEventSite(preferred.id);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setPreparingDisruption(false); }
  }
  async function disrupt() {
    setPreparingDisruption(true);
    try {
      await actions.pause();
      const target = nextSolarDisruption(playback.read(), eventSite);
      if (!target) throw new Error('No remaining sunny hour at this site. Choose another site or reset the model.');
      actions.applyEvent({ atHour: target.atHour, kind: 'solar-drop', payload: { locationId: eventSite } });
      setNotice('Solar drop scheduled at ' + place(eventSite) + ' for model hour ' + target.atHour + ' (' + time(target.startAt) + '). Step or play to reach it. Captured forecast unchanged.');
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setPreparingDisruption(false); }
  }
  return <>
    <div className="fleet-livebar"><div className="fleet-clock" data-playing={playback.playing}><em className="fleet-clock-label">Simulation clock</em><span className={playback.playing ? 'clock-pulse' : ''} />
      {(failure || progress.done || !playback.playing) && <strong>{failure ? 'Stopped' : progress.done ? 'Complete' : 'Paused'}</strong>}
      <output aria-label="Fleet model hour" data-hour={progress.hour}>{progress.hour} / {progress.totalHours} h</output>
      <small className="fleet-clock-rate" title={time(currentAt)}>1 simulated hour ≈ {number(fleetSecondsPerHour / playback.speed)}s</small>
      {!progress.done && !failure && <small className="fleet-finish">{playback.playing ? 'Final result in ~' : 'Playback remaining ~'}{timeToResult}</small>}</div>
      <div className="fleet-play-actions">{!progress.done && <button className="fleet-pause" aria-label={playback.playing ? 'Pause fleet simulation' : 'Resume fleet simulation'} disabled={saving || preparingDisruption} onClick={() => { if (playback.playing) void actions.pause(); else actions.play(); }}>{playback.playing ? 'Ⅱ Pause' : '▷ Resume'}</button>}<button className="fleet-monkey" aria-label="Chaos monkey" aria-expanded={monkey} onClick={() => void openDisruption()}>🐒 <span>Disrupt</span></button></div></div>
    <FleetSummary progress={progress} />
    <div className="fleet-stage">
      <FleetMap selectedJob={jobId} completed={progress.done && !failure} activityEpoch={activityEpoch} sites={sites} transfers={progress.selected.run.transfers} playing={playback.playing}
        admissions={admissions} onOrigin={inspectOrigin} selected={selected} onInspect={inspect} onJob={inspectJob} />
      {!monkey && (active || job || origin) && <aside className="fleet-inspector">
        <button className="fleet-close" aria-label="Close activity" onClick={closeInspection}>×</button>
        {origin && <section aria-label="Data center activity" data-origin-id={origin.id}><p className="eyebrow">SIMULATED JOB ORIGIN</p><h3>{origin.name}</h3>
          <p>{admissions.filter(job => originForJob(job.jobId).id === origin.id).length} generated {admissions.filter(job => originForJob(job.jobId).id === origin.id).length === 1 ? 'job' : 'jobs'}</p>
          <p className="fleet-origin-note">Blue routes submit synthetic jobs to their assigned home queues. The scheduler then chooses when to run or transfer them.</p>
          <a href={origin.sourceUrl} target="_blank" rel="noreferrer">Public location reference</a>
          <div className="fleet-site-jobs">{arrived.filter(job => originForJob(job.id).id === origin.id).slice(-6).map(job => <button key={job.id} onClick={() => inspectJob(job.id)}>{job.id}<span>{jobActivity(progress, job)}</span></button>)}</div>
          <small>Location is public. Jobs are simulated. No connection to this operator.</small>
        </section>}
        {active && <section aria-label="Location activity" data-location-id={active.id} data-hour={progress.hour}>
          <p className="eyebrow">COMPUTE SITE · MODELED</p><h3>{active.name}</h3><p className="fleet-inspect-time">{time(currentAt)} · Grid region {progress.scenario.sites.find(site => site.configuration.locationId === active.id)?.regionId}</p>
          <p className="fleet-section-label">Energy-supported GPUs · up to</p><div className="fleet-capacity"><strong data-testid="location-physical-gpus">{active.availableGpus ?? 'Unknown'}<small> / {active.capacity}</small></strong><span>GPUs available<br />for this hour</span></div>
          <div className="fleet-capacity-bar" role="meter" aria-label="Available modeled GPUs" aria-valuemin={0} aria-valuemax={active.capacity} aria-valuenow={active.availableGpus ?? undefined} aria-valuetext={active.availableGpus === null ? "Unknown" : undefined}>{Array.from({ length: active.capacity }, (_, index) => <i key={index} data-free={active.availableGpus !== null && index < active.availableGpus} />)}</div>
          <p className="fleet-capacity-note">{active.remainingEnergyKWh === null ? 'Modeled energy budget unknown.' : `${number(active.remainingEnergyKWh)} kWh modeled energy budget remaining.`} Runtime may be less than one hour. Colors show capacity, not carbon ranking.</p>
          <p className="fleet-active-count" data-testid="location-schedule">{active.plannedGpus === null ? 'No current plan' : `Scheduler opened ${active.plannedGpus} GPUs`} · {active.scheduledGpus} GPUs scheduled</p>
          <p className="fleet-capacity-note">The scheduler may leave supported capacity unused. {active.capacityState === 'allocated' && 'This hour’s offered capacity is committed to accepted work.'}</p>
          <p className="fleet-active-count">{active.activeJobs} jobs working · {active.queuedJobs} waiting here</p>
          <div className="fleet-power-heading"><span>Powering this compute site</span><small>This model hour</small></div>
          <dl className="fleet-metrics"><div><dt><i className="energy-key solar" />Solar power</dt><dd><span data-testid="location-solar-kw" data-value={active.solarKW}>{number(active.solarKW)}</span> kW</dd></div>
            <div><dt><i className="energy-key compute" />Work energy used</dt><dd><span data-testid="location-compute-kwh" data-value={activeMeter?.computeKWh ?? 0}>{activeMeter ? number(activeMeter.computeKWh) : 'Pending'}</span>{activeMeter && ' kWh'}</dd></div>
            <div><dt><i className="energy-key battery" />Stored energy</dt><dd><span data-testid="location-storage-kwh" data-value={active.storedKWh}>{number(active.storedKWh)}</span> / {number(active.storageCapacityKWh)} kWh</dd></div>
            <div><dt><i className="energy-key grid" />Grid energy used</dt><dd>{activeMeter ? number(activeMeter.gridImportKWh) + ' kWh' : 'Pending dispatch'}</dd></div></dl>
          <div className="fleet-battery"><i style={{ width: Math.max(0, Math.min(100, active.storageCapacityKWh ? active.storedKWh / active.storageCapacityKWh * 100 : 0)) + '%' }} /></div>
          <div className="fleet-carbon-readout"><span>Estimated carbon · this hour</span><strong>{activeMeter ? activeMeter.carbonKg === undefined ? 'Unknown' : number(activeMeter.carbonKg * 1000) + ' g' : 'Pending'}</strong></div>
          <CapacityHorizon plan={progress.selected.plans?.at(-1)} locationId={active.id} />
          <small>Simulated GPUs + energy system · public weather inputs</small>
          <div className="fleet-site-jobs">{arrived.filter(job => job.currentLocation === active.id || job.transferToLocation === active.id).slice(-5).map(job =>
            <button key={job.id} onClick={() => inspectJob(job.id)}>{job.id}<span>{jobActivity(progress, job)}</span></button>)}</div>
        </section>}
        {job && <section aria-label="Job activity" data-job-id={job.id}><p className="eyebrow">GPU BATCH · SYNTHETIC WORKLOAD</p><h3>{job.id}<span className="fleet-job-status">{jobActivity(progress, job)}</span></h3>
          <FleetDecision progress={progress} jobId={job.id} onInspect={setJobId} />
          <div className="fleet-job-route"><span><small>SIMULATED JOB ORIGIN</small>{originForJob(job.id).name}</span><i aria-hidden="true">↓</i><span><small>ASSIGNED HOME QUEUE</small>{place(job.homeLocation)}</span><span><small>CURRENT MODELED SITE</small>{place(job.currentLocation)}{job.transferToLocation && ' → ' + place(job.transferToLocation)}</span></div>
          <div className="fleet-job-progress-label"><strong>{Math.round((1 - job.remainingGpuH / job.workGpuH) * 100)}%</strong><span>{number(job.workGpuH - job.remainingGpuH)} / {job.workGpuH} GPU·h</span></div>
          <div className="fleet-work-progress"><i style={{ width: (1 - job.remainingGpuH / job.workGpuH) * 100 + '%' }} /></div>
          <div className="fleet-job-timing"><span><small>READY</small>{time(job.readyAt)}</span><span><small>DEADLINE</small>{time(job.window.endAt)}</span></div>
          <div className="fleet-carbon-readout"><span>GPU energy used</span><strong>{number(jobReceipts.reduce((sum, receipt) => sum + receipt.computeKWh, 0))} kWh</strong></div>
          <MoveSignal decision={movement} destinationName={movement && place(movement.destinationLocationId)} transfer={jobChoice?.transfer} />
          <details className="fleet-job-why" open><summary>Why this location and time?</summary>
            {jobChoice && <div><strong>Last choice · model hour {jobDecision!.hour}</strong>
              {jobChoice.selection.selected && <p>{jobChoice.accepted ? 'Allocation accepted at ' : 'Allocation not accepted at '}{place(jobChoice.selection.allocation.slot.locationId)}.</p>}
            </div>}
            <p>Before executor acceptance: {jobChoice?.selection.explanation}</p><small>{jobReceipts.length} executor receipts · carbon counted in site totals</small></details>
        </section>}
      </aside>}
      {monkey && <section className="fleet-chaos" aria-label="Fleet simulation controls"><div><h3>Crash the party</h3><button aria-label="Close controls" onClick={() => setMonkey(false)}>×</button></div>
        <p>Paused for editing. Press Play or Resume to continue.</p><div className="fleet-control-row">
          <button onClick={() => void actions.pause()} disabled={!playback.playing || saving}>Pause</button><button onClick={actions.play} disabled={playback.playing || progress.done || saving || preparingDisruption}>Play</button>
          <button onClick={() => { actions.pause(); void actions.step(); }} disabled={playback.busy || progress.done || saving || preparingDisruption}>Step</button>
          <select aria-label="Playback speed" value={playback.speed} onChange={event => actions.setSpeed(Number(event.target.value))}><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></div>
        <label>Disruption location<select aria-label="Disruption location" value={eventSite} disabled={preparingDisruption || saving} onChange={event => setEventSite(event.target.value)}>{disruptionOptions.map(option => <option key={option.id} value={option.id} disabled={!option.next}>{option.name}{option.next ? ' · ' + number(option.next.solarKW) + ' kW at ' + time(option.next.startAt) : ' · no remaining solar'}</option>)}</select></label>
        <div className="fleet-disruption-target" aria-live="polite">{preparingDisruption ? 'Pausing at a settled model hour…'
          : progress.done ? 'Horizon complete. Reset the model below to try a disruption.'
            : disruption ? <><strong>{number(disruption.solarKW)} kW → 0 kW</strong><span>Model hour {disruption.atHour} · {time(disruption.startAt)}{disruption.atHour > progress.hour ? ' · next sunny hour' : ' · next step'}</span></>
              : 'No sunny hours remain at this site. Choose another city or reset the model.'}</div>
        <button className="fleet-drop" onClick={() => void disrupt()} disabled={preparingDisruption || saving || !disruption}>Drop solar</button>
        <small>Only modeled realized solar changes. Both policies keep the captured forecast. Step or play to the displayed hour.</small>
        {notice && <p role="status">{notice}</p>}
        <button disabled={saving || playback.busy} onClick={() => void freezeMoment()}>{saving ? 'Saving frozen moment…' : 'Save frozen moment'}</button>
        {savedMoment && <div className="fleet-saved-moment"><small>Capture ID</small><code data-testid="frozen-capture-id">{savedMoment.revision}</code>
          <button onClick={() => void loadFleetMoment(savedMoment.revision).then(onRestore).catch(error => setNotice(error instanceof Error ? error.message : String(error)))}>Restore frozen moment</button></div>}<button onClick={async () => { try { await actions.reset(); setActivityEpoch(value => value + 1); setNotice('Captured starting moment restored. Press Play to continue.'); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } }} disabled={playback.busy}>Reset model</button>
      </section>}
    </div>
    <div className="fleet-footer"><details className="fleet-jobs-disclosure"><summary>Inspect jobs</summary><div className="fleet-work-strip" aria-label="Fleet jobs">{arrived.map(job => <button key={job.id} aria-label={`Inspect ${job.id}`} data-job-state={job.state}
      aria-pressed={jobId === job.id} onClick={() => inspectJob(job.id)}><i /><strong>{job.id}</strong><span>{jobActivity(progress, job)}</span></button>)}</div></details><button aria-label="Download model evidence" onClick={() => download(progress)}>Export evidence</button></div>
    {failure && <p role="alert">Model stopped: {failure.explanation} Partial receipts retained.</p>}
  </>;
}
