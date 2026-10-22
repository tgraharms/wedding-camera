import { useState } from "react";
import type { EventInfo } from "../../lib/types";

// datetime-local values are local wall-clock time with no offset (e.g.
// "2026-07-01T14:00"). new Date(...) on that string parses it as local time,
// so .toISOString() gives back the correct UTC instant.
function toIso(localValue: string): string {
  return new Date(localValue).toISOString();
}

// Slices a stored ISO instant down to the "YYYY-MM-DDTHH:mm" shape a
// datetime-local input expects, rendered in the browser's local time.
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function EventRow({
  event,
  onSave,
  onDelete,
}: {
  event: EventInfo;
  onSave: (patch: { eventId: string; name?: string; windowStart?: string; windowEnd?: string }) => Promise<void>;
  onDelete: (eventId: string) => Promise<void>;
}) {
  const [name, setName] = useState(event.name);
  const [start, setStart] = useState(toLocalInput(event.windowStart));
  const [end, setEnd] = useState(toLocalInput(event.windowEnd));
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      await onSave({
        eventId: event.id,
        name: name.trim(),
        windowStart: start ? toIso(start) : undefined,
        windowEnd: end ? toIso(end) : undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "gagal menyimpan");
    }
  }

  async function del() {
    if (event.count > 0 && !confirm(`Padam "${event.name}"? Acara ini mempunyai ${event.count} gambar.`)) return;
    setError(null);
    try {
      await onDelete(event.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "gagal memadam");
    }
  }

  return (
    <tr>
      <td data-label="Nama">
        <label htmlFor={`name-${event.id}`}>Nama {event.name}</label>
        <input id={`name-${event.id}`} value={name} onChange={(e) => setName(e.target.value)} />
      </td>
      <td data-label="Mula">
        <label htmlFor={`start-${event.id}`}>Mula {event.name}</label>
        <input
          id={`start-${event.id}`}
          type="datetime-local"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
      </td>
      <td data-label="Tamat">
        <label htmlFor={`end-${event.id}`}>Tamat {event.name}</label>
        <input id={`end-${event.id}`} type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
      </td>
      <td data-label="Gambar"><span className="admin-count">{event.count}</span></td>
      <td>
        <button aria-label={`Simpan ${event.name}`} onClick={() => void save()}>Simpan</button>
        <button className="admin-danger" aria-label={`Padam ${event.name}`} onClick={() => void del()}>Padam</button>
        {error && <p role="alert">{error}</p>}
      </td>
    </tr>
  );
}

export function AdminEvents({
  events,
  onSave,
  onDelete,
  onCreate,
}: {
  events: EventInfo[];
  onSave: (patch: { eventId: string; name?: string; windowStart?: string; windowEnd?: string }) => Promise<void>;
  onDelete: (eventId: string) => Promise<void>;
  onCreate: (input: { name: string; windowStart: string; windowEnd: string }) => Promise<void>;
}) {
  const [newName, setNewName] = useState("");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  async function create() {
    setCreateError(null);
    if (!newName.trim() || !newStart || !newEnd) {
      setCreateError("nama, mula dan tamat diperlukan");
      return;
    }
    try {
      await onCreate({ name: newName.trim(), windowStart: toIso(newStart), windowEnd: toIso(newEnd) });
      setNewName("");
      setNewStart("");
      setNewEnd("");
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "gagal menambah acara");
    }
  }

  return (
    <div className="admin-section">
      <div className="admin-title"><div><span className="admin-eyebrow">PENGURUSAN MAJLIS</span><h2>Acara</h2><p>Atur nama dan waktu untuk setiap acara.</p></div><span className="admin-count">{events.length} acara</span></div>
      <div className="admin-panel"><table className="admin-events">
        <thead>
          <tr>
            <th>Nama</th>
            <th>Mula</th>
            <th>Tamat</th>
            <th>Gambar</th>
            <th>Tindakan</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <EventRow key={event.id} event={event} onSave={onSave} onDelete={onDelete} />
          ))}
          <tr className="admin-new-event">
            <td>
              <label htmlFor="new-name">Nama acara baharu</label>
              <input id="new-name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </td>
            <td>
              <label htmlFor="new-start">Mula acara baharu</label>
              <input id="new-start" type="datetime-local" value={newStart} onChange={(e) => setNewStart(e.target.value)} />
            </td>
            <td>
              <label htmlFor="new-end">Tamat acara baharu</label>
              <input id="new-end" type="datetime-local" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} />
            </td>
            <td />
            <td>
              <button onClick={() => void create()}>Tambah Acara</button>
              {createError && <p role="alert">{createError}</p>}
            </td>
          </tr>
        </tbody>
      </table></div>
    </div>
  );
}
