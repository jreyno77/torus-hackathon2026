import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './FleetMap.css';
import { dataCenters, originForJob } from '../../data/dataCenters';
import { createFleetActivity } from './fleetActivity';
import type { TransferObservation } from '../../core/execution/TransferObservation.type';
import type { FleetCapacity } from './fleetCapacity';

export type FleetSiteVisual = FleetCapacity & {
  id: string; name: string; latitude: number; longitude: number;
  capacity: number; solarKW: number; storedKWh: number; storageCapacityKWh: number;
  activeJobs: number; queuedJobs: number;
};
type Props = {
  activityEpoch?: number; sites: FleetSiteVisual[]; transfers: readonly TransferObservation[]; playing: boolean; completed?: boolean;
  admissions?: Array<{ jobId: string; homeLocation: string }>; onOrigin?: (id: string) => void;
  selected?: string; selectedJob?: string; onInspect: (id: string) => void; onJob: (id: string) => void;
};
const color = (site: FleetSiteVisual, completed: boolean) => completed ? '#7c929c' : site.capacityState === 'unknown' ? '#89969a'
  : site.capacityState === 'allocated' ? '#7298b5' : site.capacityState === 'constrained' ? '#d16f63'
  : site.availableGpus! < site.capacity / 2 ? '#d7af5e' : '#53ad83';

export function FleetMapKey() {
  return <div className="fleet-map-key" role="group" aria-label="Modeled job flow">
      <div className="fleet-map-key-flow">
        <span><i className="fleet-map-key-origin" aria-hidden="true"></i>Simulated jobs</span>
        <b aria-hidden="true">→</b>
        <span><i className="fleet-map-key-compute" aria-hidden="true"></i>Modeled compute</span>

      </div>
    </div>;
}

/** One persistent geographic view. Camera changes never step or reconstruct the model. */
export function FleetMap({ sites, transfers, playing, completed = false, selected, selectedJob, onInspect, onJob, admissions = [], onOrigin, activityEpoch = 0 }: Props) {
  const [routeHistory, setRouteHistory] = useState(false);
  const [mapZoom, setMapZoom] = useState(3);
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const seen = useRef(new Set<string>());
  const activity = useRef<ReturnType<typeof createFleetActivity> | null>(null);
  const callbacks = useRef({ onInspect, onJob, onOrigin });
  callbacks.current = { onInspect, onJob, onOrigin };
  useEffect(() => {
    // Mount and Reset show existing history quietly. Only later additions announce activity.
    seen.current = new Set([...transfers.map(item => item.id), ...admissions.map(item => `admission:${item.jobId}`)]);
    activity.current?.clear();
  }, [activityEpoch]);
  useEffect(() => {
    const element = container.current!;
    const view = L.map(element, { zoomControl: false, scrollWheelZoom: true, zoomAnimation: false, zoomSnap: .25 });
    map.current = view;
    activity.current = createFleetActivity(view);
    const initialBounds = L.latLngBounds([[25, -125], [49, -67]]);
    const padding = L.point(40, 55);
    // Layers need a finite camera even when the CPU pane initially hides this map.
    view.setView(initialBounds.getCenter(), 3);
    const updateLabelDetail = () => { element.dataset.detailLabels = String(view.getZoom() >= 5); setMapZoom(view.getZoom()); };
    updateLabelDetail();
    view.on('zoomend', updateLabelDetail);
    L.control.zoom({ position: 'bottomleft' }).addTo(view);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(view);
    let initiallyFitted = false;
    let disposed = false;
    const resize = new ResizeObserver(() => {
      if (disposed) return;
      // A zero-size container minus padding produces an invalid bounds-fit scale.
      if (element.clientWidth <= padding.x * 2 || element.clientHeight <= padding.y * 2) return;
      view.invalidateSize({ pan: false });
      if (!initiallyFitted) {
        view.fitBounds(initialBounds, { padding, animate: false });
        initiallyFitted = true;
      }
    });
    resize.observe(element);
    return () => { disposed = true; resize.disconnect(); view.off('zoomend', updateLabelDetail); activity.current?.clear(); view.remove(); map.current = null; activity.current = null; };
  }, []);
  useEffect(() => {
    const layer = L.layerGroup().addTo(map.current!);
    for (const site of sites) {
      if (!Number.isFinite(site.latitude) || !Number.isFinite(site.longitude)) continue;
      const element = document.createElement('button');
      element.className = 'fleet-node';
      element.style.setProperty('--site-color', color(site, completed));
      element.dataset.siteId = site.id;
      element.dataset.capacityState = site.capacityState;
      element.dataset.physicalGpus = String(site.availableGpus ?? 'unknown');
      element.dataset.state = completed ? 'complete' : site.capacityState === 'unknown' ? 'unknown' : site.activeJobs ? 'working' : site.capacityState;
      element.setAttribute('aria-label', `Inspect ${site.name}`);
      element.setAttribute('aria-pressed', String(selected === site.id));
      element.innerHTML = '<span class="fleet-node-halo"></span><span class="fleet-node-body"></span><span class="fleet-node-name"></span>';
      element.querySelector('.fleet-node-name')!.textContent = site.name;
      element.addEventListener('click', event => { event.stopPropagation(); callbacks.current.onInspect(site.id); });
      L.marker([site.latitude, site.longitude], { keyboard: false,
        icon: L.divIcon({ html: element, className: 'fleet-marker', iconSize: [50, 50], iconAnchor: [25, 25] }) }).addTo(layer);
    }
    return () => { layer.remove(); };
  }, [sites, selected, completed]);
  useEffect(() => {
    const view = map.current!;
    const layer = L.layerGroup().addTo(view);
    for (const [index, transfer] of transfers.entries()) {
      const from = sites.find(site => site.id === transfer.fromLocation), to = sites.find(site => site.id === transfer.toLocation);
      if (!from || !to) continue;
      const points: L.LatLngTuple[] = Array.from({ length: 33 }, (_, index) => {
        const t = index / 32;
        return [from.latitude + (to.latitude - from.latitude) * t + Math.sin(t * Math.PI) * Math.abs(to.longitude - from.longitude) * .14,
          from.longitude + (to.longitude - from.longitude) * t];
      });
      // Static route density never limits the real event announcements below.
      if (transfer.jobId === selectedJob || (routeHistory && index >= transfers.length - 10)) {
        const line = L.polyline(points, { color: '#0d9488', weight: 2, opacity: .42, className: 'fleet-route' }).addTo(layer);
        const path = line.getElement();
        path?.setAttribute('data-job-id', transfer.jobId);
        path?.setAttribute('data-transfer-id', transfer.id);
        path?.setAttribute('role', 'button');
        path?.setAttribute('tabindex', '0');
        path?.setAttribute('aria-label', `Inspect transfer ${transfer.jobId} from ${from.name} to ${to.name}`);
        line.on('click', () => callbacks.current.onJob(transfer.jobId));
        path?.addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Enter') callbacks.current.onJob(transfer.jobId); });
      }
      if (!seen.current.has(transfer.id)) {
        seen.current.add(transfer.id);
        activity.current?.show({ id: transfer.id, jobId: transfer.jobId, kind: 'transfer', route: points,
          from: { name: from.name, point: [from.latitude, from.longitude] },
          to: { name: to.name, point: [to.latitude, to.longitude] } });
      }
    }
    return () => { layer.remove(); };
  }, [transfers, activityEpoch, routeHistory, selectedJob]);
  useEffect(() => {
    const view = map.current!;
    const layer = L.layerGroup().addTo(view);
    // Nearby reference locations separate by a few pixels at overview scale so both dots stay selectable.
    function originPoint(source: { latitude: number; longitude: number }): L.LatLngTuple {
      const actual = view.latLngToLayerPoint([source.latitude, source.longitude]);
      const sitePoints = sites.filter(site => Number.isFinite(site.latitude) && Number.isFinite(site.longitude))
        .map(site => view.latLngToLayerPoint([site.latitude, site.longitude]));
      if (sitePoints.every(point => actual.distanceTo(point) >= 18)) return [source.latitude, source.longitude];
      const candidates = [[0, -26], [26, 0], [-26, 0], [0, 26]].map(([x, y]) => actual.add([x, y]));
      const clear = candidates.find(candidate => sitePoints.every(point => candidate.distanceTo(point) >= 20)) ?? candidates[0];
      const display = view.layerPointToLatLng(clear);
      return [display.lat, display.lng];
    }
    for (const source of dataCenters) {
      const point = originPoint(source);
      if (point[0] !== source.latitude || point[1] !== source.longitude) {
        L.polyline([[source.latitude, source.longitude], point], { color: '#2563eb', weight: 1, opacity: .2, interactive: false }).addTo(layer);
      }
      const element = document.createElement('button');
      element.className = 'fleet-datacenter';
      element.setAttribute('aria-label', `Inspect data center ${source.name}`);
      element.innerHTML = '<span class="fleet-origin-body" aria-hidden="true"></span>';
      element.addEventListener('click', () => callbacks.current.onOrigin?.(source.id));
      L.marker(point, { keyboard: false,
        icon: L.divIcon({ html: element, className: 'fleet-marker', iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(layer);
    }
    for (const [index, admission] of admissions.entries()) {
      const source = originForJob(admission.jobId), destination = sites.find(site => site.id === admission.homeLocation);
      if (!destination) continue;
      const start = originPoint(source);
      const points: L.LatLngTuple[] = Array.from({ length: 25 }, (_, index) => {
        const t = index / 24;
        return [start[0] + (destination.latitude - start[0]) * t + Math.sin(t * Math.PI) * Math.abs(destination.longitude - start[1]) * .08,
          start[1] + (destination.longitude - start[1]) * t];
      });
      const identity = `admission:${admission.jobId}`;
      if (admission.jobId === selectedJob || (routeHistory && index >= admissions.length - 6)) {
        const line = L.polyline(points, { color: '#2563eb', weight: 1.5, opacity: .3, dashArray: '3 6', className: 'fleet-admission' }).addTo(layer);
        const path = line.getElement();
        path?.setAttribute('data-job-id', admission.jobId);
        path?.setAttribute('data-event-id', identity);
        path?.setAttribute('role', 'button');
        path?.setAttribute('tabindex', '0');
        path?.setAttribute('aria-label', `Inspect submission ${admission.jobId} from ${source.name} to ${destination.name}`);
        line.on('click', () => callbacks.current.onJob(admission.jobId));
        path?.addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Enter') callbacks.current.onJob(admission.jobId); });
      }
      if (!seen.current.has(identity)) {
        seen.current.add(identity);
        activity.current?.show({ id: identity, jobId: admission.jobId, kind: 'submission', route: points,
          from: { name: source.name, point: start },
          to: { name: destination.name, point: [destination.latitude, destination.longitude] } });
      }
    }
    return () => { layer.remove(); };
  }, [admissions, activityEpoch, routeHistory, selectedJob, mapZoom]);
  function zoom(utah: boolean) {
    map.current?.fitBounds(utah ? [[36.8, -114.4], [41.6, -110.5]] : [[25, -125], [49, -67]], { padding: [40, 55], animate: false });
  }
  return <div className="fleet-geography compact-energy-map" data-playing={playing}>
    <div className="fleet-canvas" ref={container} role="region" aria-label="Continuous fleet map" />
    <div className="fleet-camera"><button onClick={() => zoom(false)}>Show US</button><button onClick={() => zoom(true)}>Explore Utah</button>
      <button className="fleet-route-history" aria-label="Show route history" aria-pressed={routeHistory} onClick={() => setRouteHistory(value => !value)}>Routes</button></div>
    <div className="fleet-legend"><FleetMapKey /><strong className="fleet-legend-title">Energy-supported GPU capacity · modeled</strong>
      {completed ? <span><i style={{ background: '#7c929c' }} />Model complete · inspect results</span> : <>
        <span><i style={{ background: '#53ad83' }} />Open</span><span><i style={{ background: '#d7af5e' }} />Limited</span>
        <span><i style={{ background: '#7298b5' }} />Allocated</span><span><i style={{ background: '#d16f63' }} />Energy constrained</span><span><i style={{ background: '#89969a' }} />Unknown</span>
      </>}
      <small>Capacity, not carbon ranking</small>
      <small className="fleet-activity-key"><span><i style={{ background: '#2563eb' }} />Submission to home queue</span><span><i style={{ background: '#0d9488' }} />Chosen site move</span></small>
    </div>
  </div>;
}
