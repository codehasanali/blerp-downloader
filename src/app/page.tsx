"use client";

import { useState } from "react";

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [preparedGif, setPreparedGif] = useState<Blob | null>(null);
  const [preparedGifName, setPreparedGifName] = useState("yml_cover.gif");
  const [preparedGifForUrl, setPreparedGifForUrl] = useState("");

  async function handleDownloadVideoOneClick() {
    const normalizedUrl = url.trim();
    if (!normalizedUrl) return;
    try {
      setLoading(true);

      let gifBlob = preparedGif;
      let gifName = preparedGifName;

      // URL değiştiyse veya gif yoksa otomatik 1. adımı burada yap.
      if (!gifBlob || preparedGifForUrl !== normalizedUrl) {
        const coverResp = await fetch("/api/download-main-cover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: normalizedUrl }),
        });

        if (!coverResp.ok) {
          let msg = "Kapak (GIF) hazırlanamadı.";
          try {
            const data = await coverResp.json();
            if ((data as any)?.error) msg = (data as any).error;
          } catch {
            // ignore
          }
          alert(msg);
          return;
        }

        gifBlob = await coverResp.blob();
        const disposition = coverResp.headers.get("content-disposition") || "";
        const match = disposition.match(/filename="([^"]+)"/i);
        gifName = match?.[1] || "yml_cover.gif";

        setPreparedGif(gifBlob);
        setPreparedGifName(gifName);
        setPreparedGifForUrl(normalizedUrl);
      }

      if (!gifBlob) {
        alert("GIF hazırlanamadı.");
        return;
      }

      const form = new FormData();
      form.append("url", normalizedUrl);
      form.append(
        "gif",
        new File([gifBlob], gifName || "yml_cover.gif", {
          type: "image/gif",
        })
      );

      const resp = await fetch("/api/download-video-from-gif", {
        method: "POST",
        body: form,
      });

      if (!resp.ok) {
        let msg = "Video indirilemedi.";
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
      let filename = "blerp_video.mp4";
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
          Tek butonla önce kapak GIF hazırlanır, sonra ses + GIF birleştirilip
          video indirilir.
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
              onChange={(e) => {
                setUrl(e.target.value);
              }}
            />
          </label>

          <div className="mt-2 grid grid-cols-1 gap-3">
            <button
              type="button"
              onClick={handleDownloadVideoOneClick}
              disabled={!url || loading}
              className="inline-flex w-full items-center justify-center rounded-xl bg-zinc-600 px-4 py-2 text-sm font-medium text-zinc-50 shadow-sm transition hover:bg-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:ring-offset-2"
            >
              {loading ? "İşleniyor..." : "Ses + Video İndir (Tek Tık)"}
            </button>
          </div>

          <p className="mt-4 text-xs text-zinc-500">
            Bu araç sadece kullanım hakkın olan içerikleri kişisel olarak
            indirmen içindir.
          </p>
        </div>
      </main>
    </div>
  );
}

