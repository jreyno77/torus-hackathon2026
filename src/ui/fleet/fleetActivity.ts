import L from 'leaflet';
import { showMapActivity } from '../energy/mapActivity';

type Endpoint = { name: string; point: L.LatLngTuple };
type FleetEvent = {
  id: string;
  jobId: string;
  kind: 'submission' | 'transfer';
  from: Endpoint;
  to: Endpoint;
  route: L.LatLngTuple[];
};

const travelMs = 900;
const pulseMs = 500;
const lifetimeMs = travelMs + pulseMs;

/** Each supplied event gets one departure-to-destination cue, never idle animation. */
export function createFleetActivity(view: L.Map) {
  const active = new Map<string, { close: () => void }>();
  function clear() {
    for (const feedback of [...active.values()]) feedback.close();
  }
  view.once('unload', clear);

  function show(event: FleetEvent) {
    active.get(event.id)?.close();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const color = event.kind === 'submission' ? '#2563eb' : '#0d9488';
    const layer = L.layerGroup().addTo(view);
    const endTrail = showMapActivity(view, event.route, color, { durationMs: travelMs, tailLength: .07 });
    const timers: ReturnType<typeof setTimeout>[] = [];
    let closed = false;
    const kind = event.kind === 'submission' ? 'Simulated submission to home queue' : 'Modeled transfer';

    function pulse(endpoint: 'source' | 'destination', value: Endpoint) {
      const marker = L.circleMarker(value.point, {
        interactive: false, radius: 7, color, weight: 1.5, fillColor: color, fillOpacity: .08,
        className: 'fleet-event-pulse',
      }).addTo(layer);
      const element = marker.getElement() as SVGPathElement;
      element.setAttribute('data-event-id', event.id);
      element.setAttribute('data-endpoint', endpoint);
      element.setAttribute('data-job-id', event.jobId);
      element.setAttribute('data-kind', event.kind);
      element.setAttribute('role', 'img');
      element.setAttribute('aria-label', event.jobId + ' · ' + kind + ' · ' + endpoint + ': ' + value.name
        + ' · ' + event.from.name + ' → ' + event.to.name);
      element.style.pointerEvents = 'none';
      element.style.animationDuration = pulseMs + 'ms';
      element.style.animationIterationCount = '1';
      element.style.animationTimingFunction = 'ease-out';
      if (reducedMotion) element.style.animation = 'none';
      return marker;
    }

    const departure = pulse('source', event.from);
    if (reducedMotion) {
      // Brief static endpoints preserve event identity without suggesting motion.
      pulse('destination', event.to);
    } else {
      timers.push(setTimeout(() => layer.removeLayer(departure), pulseMs));
      timers.push(setTimeout(() => { if (!closed) pulse('destination', event.to); }, travelMs));
    }
    // Static routes and the job inspector retain hover/click provenance after this cue expires.
    timers.push(setTimeout(close, lifetimeMs));
    function close() {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      endTrail();
      layer.remove();
      active.delete(event.id);
    }
    active.set(event.id, { close });
  }

  return { show, clear };
}
