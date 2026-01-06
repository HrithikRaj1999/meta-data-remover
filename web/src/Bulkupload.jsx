import { useDropzone } from "react-dropzone";
import { useState } from "react";
import { presignUpload, createJob } from "./api.js";

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

async function runWithConcurrency(tasks, concurrency = 5) {
  const c = clamp(concurrency, 1, 20);
  const queue = tasks.slice();
  const workers = new Array(c).fill(0).map(async () => {
    while (queue.length) await queue.shift()();
  });
  await Promise.all(workers);
}

async function uploadToS3(url, file) {
  const r = await fetch(url, { method: "PUT", body: file });
  if (!r.ok) throw new Error("S3 upload failed");
}

export default function BulkUpload({ onJobCreated }) {
  const [rows, setRows] = useState([]);
  const [userId, setUserId] = useState("user1");
  const [busy, setBusy] = useState(false);
  const [concurrency, setConcurrency] = useState(5);

  const { getRootProps, getInputProps } = useDropzone({
    accept: { "application/pdf": [".pdf"] },
    multiple: true,
    onDrop: (accepted) => {
      const add = accepted.map((file) => ({
        file,
        s3Key: null,
        status: "READY",
        operation: "REMOVE",
        edit: {
          author: "",
          title: "",
          subject: "",
          keywords: "",
          creator: "",
          producer: "",
        },
      }));
      setRows((prev) => [...prev, ...add]);
    },
  });

  async function uploadAll() {
    setBusy(true);
    try {
      const tasks = rows.map((row, idx) => async () => {
        if (row.s3Key) return;

        setRows((prev) => {
          const copy = [...prev];
          copy[idx] = { ...copy[idx], status: "PRESIGNING" };
          return copy;
        });

        const { key, url } = await presignUpload(row.file);

        setRows((prev) => {
          const copy = [...prev];
          copy[idx] = { ...copy[idx], status: "UPLOADING" };
          return copy;
        });

        await uploadToS3(url, row.file);

        setRows((prev) => {
          const copy = [...prev];
          copy[idx] = { ...copy[idx], status: "UPLOADED", s3Key: key };
          return copy;
        });
      });

      await runWithConcurrency(tasks, concurrency);
    } finally {
      setBusy(false);
    }
  }

  async function createProcessingJob() {
    const items = rows
      .filter((r) => r.s3Key)
      .map((r) => ({
        inputKey: r.s3Key,
        operation: r.operation,
        edit:
          r.operation === "EDIT"
            ? Object.fromEntries(
                Object.entries(r.edit).filter(([_, v]) => v && v.trim())
              )
            : undefined,
      }));

    if (items.length === 0) {
      alert("Upload at least 1 PDF first.");
      return;
    }

    setBusy(true);
    try {
      const { jobId } = await createJob({ userId, items });
      onJobCreated(jobId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 1100, margin: "0 auto" }}>
      <h2>PDF Metadata Bulk Remove / Edit</h2>

      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <label>
          User:
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            style={{ marginLeft: 8 }}
          />
        </label>

        <label>
          Upload concurrency:
          <input
            type="number"
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            style={{ marginLeft: 8, width: 80 }}
          />
        </label>

        <button disabled={busy || rows.length === 0} onClick={uploadAll}>
          Upload All
        </button>
        <button
          disabled={busy || rows.filter((r) => r.s3Key).length === 0}
          onClick={createProcessingJob}
        >
          Process
        </button>

        <div style={{ marginLeft: "auto" }}>
          Files: {rows.length} | Uploaded: {rows.filter((r) => r.s3Key).length}
        </div>
      </div>

      <div
        {...getRootProps()}
        style={{
          border: "2px dashed #888",
          padding: 22,
          borderRadius: 10,
          cursor: "pointer",
        }}
      >
        <input {...getInputProps()} />
        <strong>Drag & drop PDFs</strong> (1000+ supported) or click.
      </div>

      <div
        style={{
          marginTop: 12,
          maxHeight: 520,
          overflow: "auto",
          border: "1px solid #ddd",
          borderRadius: 8,
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ position: "sticky", top: 0, background: "#fff" }}>
              <th
                style={{
                  textAlign: "left",
                  padding: 8,
                  borderBottom: "1px solid #ddd",
                }}
              >
                File
              </th>
              <th style={{ padding: 8, borderBottom: "1px solid #ddd" }}>
                Action
              </th>
              <th style={{ padding: 8, borderBottom: "1px solid #ddd" }}>
                Edit fields (if EDIT)
              </th>
              <th style={{ padding: 8, borderBottom: "1px solid #ddd" }}>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.file.name}-${i}`}
                style={{ borderBottom: "1px solid #eee" }}
              >
                <td style={{ padding: 8 }}>
                  <div>
                    <strong>{r.file.name}</strong>
                  </div>
                  <div style={{ fontSize: 12, color: "#666" }}>
                    {(r.file.size / (1024 * 1024)).toFixed(2)} MB
                  </div>
                </td>

                <td style={{ padding: 8 }}>
                  <select
                    value={r.operation}
                    onChange={(e) => {
                      const op = e.target.value;
                      setRows((prev) => {
                        const copy = [...prev];
                        copy[i] = { ...copy[i], operation: op };
                        return copy;
                      });
                    }}
                  >
                    <option value="REMOVE">Remove</option>
                    <option value="EDIT">Edit</option>
                  </select>
                </td>

                <td style={{ padding: 8 }}>
                  {r.operation === "EDIT" ? (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 8,
                      }}
                    >
                      {[
                        "author",
                        "title",
                        "subject",
                        "keywords",
                        "creator",
                        "producer",
                      ].map((k) => (
                        <input
                          key={k}
                          placeholder={k}
                          value={r.edit[k]}
                          onChange={(e) => {
                            const v = e.target.value;
                            setRows((prev) => {
                              const copy = [...prev];
                              copy[i] = {
                                ...copy[i],
                                edit: { ...copy[i].edit, [k]: v },
                              };
                              return copy;
                            });
                          }}
                        />
                      ))}
                    </div>
                  ) : (
                    <span style={{ color: "#999" }}>—</span>
                  )}
                </td>

                <td style={{ padding: 8, textAlign: "center" }}>
                  {r.status} {r.s3Key ? "✅" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
