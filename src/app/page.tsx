"use client";

import { useState } from "react";

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleDownload() {
    if (!url) return;
    try {
      setLoading(true);
      const resp = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (!resp.ok) {
        let msg = "İndirme başarısız.";
        try {
          const data = await resp.json();
          if ((data as any)?.error) msg = (data as any).error;
        } catch {
          // ignore
        }
        alert(msg);
        return;
      }

      const blob = await resp.blob();
      const disposition = resp.headers.get("content-disposition") || "";
      let filename = "blerp_sound";
      const match = disposition.match(/filename="([^"]+)"/i);
      if (match?.[1]) filename = match[1];

      const urlObj = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = urlObj;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(urlObj);
    } catch (err) {
      alert((err as Error).message || "Bir hata oluştu.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-black font-sans px-4">
      <main className="w-full max-w-xl rounded-3xl bg-zinc-900/90 p-8 shadow-xl backdrop-blur">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">
          Blerp Downloader
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          Blerp soundbites linkini gir, arkada sunucu sesi indirip sana dosya
          olarak versin.
        </p>

        <div className="mt-8 space-y-4">
          <label className="block text-sm font-medium text-zinc-300">
            Blerp soundbites URL
            <input
              type="url"
              required
              placeholder="https://blerp.com/soundbites/..."
              className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-50 outline-none ring-0 transition focus:border-zinc-500 focus:bg-zinc-950 focus:ring-2 focus:ring-zinc-700"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>

          <button
            type="button"
            onClick={handleDownload}
            disabled={!url || loading}
            className="mt-2 inline-flex w-full items-center justify-center rounded-xl bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 shadow-sm transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2"
          >
            {loading ? "İndiriliyor..." : "İndir"}
          </button>

          <p className="mt-4 text-xs text-zinc-500">
            Bu araç sadece kullanım hakkın olan içerikleri kişisel olarak
            indirmen içindir.
          </p>
        </div>
      </main>
    </div>
  );
}

