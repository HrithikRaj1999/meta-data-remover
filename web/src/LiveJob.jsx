import { useEffect, useMemo, useState } from "react";
import { getJob, presignDownload, requestZip, presignZip } from "./api.js";

const NOTIFIER_BASE = import.meta.env.VITE_NOTIFIER_BASE;

export default function LiveJob({ jobId, onBack }) {
  const [events, setEvents] = useState([]);
  const [items, setItems] = useState(new Map());
  const [job, setJob] = useState(null);
  const [zip, setZip] = useState({ status: "NONE", key: null, error: null });

  // bootstrap job once (helps on refresh)
  useEffect(() => {
    (async () => {
      try {
        const j = await getJob(jobId);
        setJob(j);
        setZip({
          status: j.zipStatus || "NONE",
          key: j.zipKey || null,
          error: j.zipError || null,
        });
      } catch {}
    })();
  }, [jobId]);

  // SSE connection: no polling
  useEffect(() => {
    const es = new EventSource(
      `${NOTIFIER_BASE}/events?jobId=${encodeURIComponent(jobId)}`
    );

    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        setEvents((prev) => [evt, ...prev].slice(0, 5000));

        if (evt.type === "ITEM_DONE") {
          setItems((prev) => {
            const m = new Map(prev);
            m.set(evt.itemId, { status: "DONE", outputKey: evt.outputKey });
            return m;
          });
        }
        if (evt.type === "ITEM_FAILED") {
          setItems((prev) => {
            const m = new Map(prev);
            m.set(evt.itemId, { status: "FAILED", error: evt.error });
            return m;
          });
        }
        if (evt.type === "JOB_DONE") {
          setJob((prev) => ({
            ...(prev || {}),
            status: "DONE",
            itemsTotal: evt.itemsTotal,
          }));
        }
        if (evt.type === "ZIP_PROCESSING") {
          setZip({
            status: "PROCESSING",
            key: evt.zipKey || null,
            error: null,
          });
        }
        if (evt.type === "ZIP_READY") {
          setZip({ status: "READY", key: evt.zipKey, error: null });
        }
        if (evt.type === "ZIP_FAILED") {
          setZip({ status: "FAILED", key: null, error: evt.error });
        }
      } catch {}
    };

    return () => es.close();
  }, [jobId]);

  const doneCount = useMemo(() => {
    let c = 0;
    for (const v of items.values()) if (v.status === "DONE") c++;
    return c;
  }, [items]);

  async function downloadFile(outputKey) {
    const { url } = await presignDownload(outputKey);
    window.open(url, "_blank");
  }

  async function startZip() {
    try {
      const r = await requestZip(jobId);
      setZip({ status: r.zipStatus, key: r.zipKey || null, error: null });
    } catch (e) {
      alert(e.message);
    }
  }

  async function downloadZip() {
    const { url } = await presignZip(jobId);
    window.open(url, "_blank");
  }

  const sorted = useMemo(() => {
    return Array.from(items.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [items]);

  return (
    <div style={{ padding: 16, maxWidth: 1100, margin: "0 auto" }}>
      <button onClick={onBack}>← Back</button>
      <h2>Live Job: {jobId}</h2>

      <div
        style={{
          display: "flex",
          gap: 14,
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <div>
          <strong>Job status:</strong> {job?.status || "…"}
        </div>
        <div>
          <strong>Done (events):</strong> {doneCount}
        </div>

        <div style={{ marginLeft: "auto" }}>
          <strong>ZIP:</strong> {zip.status}{" "}
          {zip.status === "NONE" && job?.status === "DONE" && (
            <button onClick={startZip} style={{ marginLeft: 8 }}>
              Generate ZIP
            </button>
          )}
          {zip.status === "READY" && (
            <button onClick={downloadZip} style={{ marginLeft: 8 }}>
              Download ZIP
            </button>
          )}
          {zip.status === "FAILED" && (
            <span style={{ marginLeft: 8, color: "crimson" }}>{zip.error}</span>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 8,
            maxHeight: 600,
            overflow: "auto",
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ position: "sticky", top: 0, background: "#fff" }}>
                <th
                  style={{
                    padding: 8,
                    textAlign: "left",
                    borderBottom: "1px solid #ddd",
                  }}
                >
                  Item
                </th>
                <th style={{ padding: 8, borderBottom: "1px solid #ddd" }}>
                  Status
                </th>
                <th style={{ padding: 8, borderBottom: "1px solid #ddd" }}>
                  Download
                </th>
                <th style={{ padding: 8, borderBottom: "1px solid #ddd" }}>
                  Error
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(([itemId, v]) => (
                <tr key={itemId} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: 8 }}>{itemId}</td>
                  <td style={{ padding: 8, textAlign: "center" }}>
                    {v.status}
                  </td>
                  <td style={{ padding: 8, textAlign: "center" }}>
                    {v.status === "DONE" ? (
                      <button onClick={() => downloadFile(v.outputKey)}>
                        Download
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={{ padding: 8, color: "crimson", fontSize: 12 }}>
                    {v.error || ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 8,
            maxHeight: 600,
            overflow: "auto",
            padding: 8,
          }}
        >
          <strong>Latest events</strong>
          {events.slice(0, 250).map((e, idx) => (
            <div
              key={idx}
              style={{
                borderBottom: "1px solid #eee",
                padding: "6px 0",
                fontSize: 12,
              }}
            >
              <div>
                <b>{e.type}</b>
              </div>
              <div style={{ color: "#666" }}>{JSON.stringify(e)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
