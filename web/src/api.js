const API_BASE = import.meta.env.VITE_API_BASE;

async function jsonFetch(url, options) {
  const r = await fetch(url, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}

export const presignUpload = (file) =>
  jsonFetch(`${API_BASE}/presign/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, contentType: file.type }),
  });

export const createJob = ({ userId, items }) =>
  jsonFetch(`${API_BASE}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, items }),
  });

export const getJob = (jobId) => jsonFetch(`${API_BASE}/jobs/${jobId}`);

export const requestZip = (jobId) =>
  jsonFetch(`${API_BASE}/jobs/${jobId}/zip/request`, { method: "POST" });

export const presignZip = (jobId) =>
  jsonFetch(`${API_BASE}/jobs/${jobId}/zip/presign`);

export const presignDownload = (key) =>
  jsonFetch(`${API_BASE}/presign/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
