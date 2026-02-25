import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import fetchFn from "node-fetch";
import ffmpegPath from "ffmpeg-static";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
  Referer: "https://blerp.com/",
};

function getIdFromCdnUrl(input?: string): string | null {
  if (!input) return null;
  const m = input.match(/cdn\.blerp\.com\/(?:thumbnails|normalized)\/([^?"'<>/]+)/i);
  return m?.[1] || null;
}

function extractMainThumbnail(html: string): string | null {
  const main = html.match(
    /id=["']main-content["'][\s\S]*?<img[^>]*src=["'](https:\/\/cdn\.blerp\.com\/thumbnails\/[^"']+)["']/i
  );
  return main?.[1] || null;
}

async function findAudioUrl(html: string): Promise<string | null> {
  const allMatches = [...html.matchAll(/https:\/\/[^"'\\s]+/g)];
  const candidates = Array.from(new Set(allMatches.map((x) => x[0])));

  for (const url of candidates) {
    try {
      const head = await fetchFn(url, {
        method: "HEAD",
        headers: HEADERS,
        redirect: "follow",
      });
      const ctype = (head.headers.get("content-type") || "").toLowerCase();
      if (ctype.startsWith("audio/")) return (head as any).url || url;
    } catch {
      // ignore
    }
  }
  return null;
}

async function findAnimatedCoverUrl(
  html: string,
  staticThumbUrl: string | null
): Promise<string | null> {
  // 0) En güçlü fallback: ana thumbnail çoğu zaman animated webp oluyor.
  if (staticThumbUrl) {
    try {
      const resp = await fetchFn(staticThumbUrl, {
        method: "HEAD",
        headers: HEADERS,
        redirect: "follow",
      });
      if (resp.ok) {
        const ctype = (resp.headers.get("content-type") || "").toLowerCase();
        if (
          ctype.startsWith("video/") ||
          ctype.includes("image/gif") ||
          ctype.includes("image/webp")
        ) {
          return (resp as any).url || staticThumbUrl;
        }
      }
    } catch {
      // ignore
    }
  }

  const allMatches = [...html.matchAll(/https:\/\/[^"'\\s]+/g)];
  const candidates = Array.from(new Set(allMatches.map((x) => x[0])));

  for (const url of candidates) {
    try {
      const head = await fetchFn(url, {
        method: "HEAD",
        headers: HEADERS,
        redirect: "follow",
      });
      const ctype = (head.headers.get("content-type") || "").toLowerCase();
      if (ctype.startsWith("video/") || ctype.includes("image/gif")) {
        return (head as any).url || url;
      }
    } catch {
      // ignore
    }
  }

  const id = getIdFromCdnUrl(staticThumbUrl || undefined);
  if (!id) return null;

  const derived = [
    `https://cdn.blerp.com/normalized/${id}`,
    `https://cdn.blerp.com/normalized/${id}.mp4`,
    `https://cdn.blerp.com/normalized/${id}.webm`,
    `https://cdn.blerp.com/normalized/${id}.gif`,
    `https://cdn.blerp.com/thumbnails/${id}`,
  ];

  for (const url of derived) {
    try {
      const resp = await fetchFn(url, { method: "HEAD", headers: HEADERS, redirect: "follow" });
      if (!resp.ok) continue;
      const ctype = (resp.headers.get("content-type") || "").toLowerCase();
      if (ctype.startsWith("video/") || ctype.includes("image/gif") || ctype.includes("image/webp")) {
        return (resp as any).url || url;
      }
    } catch {
      // ignore
    }
  }

  // Son fallback: hiçbiri bulunamazsa en azından static thumbnail'i döndür.
  return staticThumbUrl;
}

async function downloadToTemp(url: string, prefix: string): Promise<{ path: string; ctype: string }> {
  const resp = await fetchFn(url, { headers: HEADERS, redirect: "follow" });
  if (!resp.ok) throw new Error(`Dosya indirilemedi: ${resp.status}`);
  const ctype = resp.headers.get("content-type") || "application/octet-stream";
  const arr = await resp.arrayBuffer();
  const filePath = join(tmpdir(), `${prefix}-${randomUUID()}`);
  await fs.writeFile(filePath, Buffer.from(arr));
  return { path: filePath, ctype };
}

function mediaExtFromType(contentType: string): string {
  const t = contentType.toLowerCase();
  if (t.includes("audio/mpeg") || t.includes("audio/mp3")) return ".mp3";
  if (t.includes("audio/ogg")) return ".ogg";
  if (t.includes("audio/wav")) return ".wav";
  if (t.includes("video/mp4")) return ".mp4";
  if (t.includes("video/webm")) return ".webm";
  if (t.includes("image/webp")) return ".webp";
  if (t.includes("image/gif")) return ".gif";
  return "";
}

function resolveFfmpegPath(): string | null {
  if (ffmpegPath && existsSync(ffmpegPath)) return ffmpegPath;

  const candidates = [
    join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg"),
    join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg.exe"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export async function POST(req: NextRequest) {
  const cleanupPaths: string[] = [];
  try {
    const body = await req.json().catch(() => ({}));
    const url = body?.url as string | undefined;

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "Geçerli bir URL gönder." }, { status: 400 });
    }
    if (!url.startsWith("https://blerp.com/soundbites/")) {
      return NextResponse.json(
        { error: "Sadece Blerp soundbites URL'leri destekleniyor." },
        { status: 400 }
      );
    }
    const ffmpegBinary = resolveFfmpegPath();
    if (!ffmpegBinary) {
      return NextResponse.json({ error: "FFmpeg bulunamadı." }, { status: 500 });
    }

    const pageResp = await fetchFn(url, { headers: HEADERS });
    if (!pageResp.ok) {
      return NextResponse.json(
        { error: "Sayfa alınamadı.", status: pageResp.status },
        { status: pageResp.status }
      );
    }

    const html = await pageResp.text();
    const staticThumbUrl = extractMainThumbnail(html);
    const audioUrl = await findAudioUrl(html);
    const animatedCoverUrl = await findAnimatedCoverUrl(html, staticThumbUrl);

    if (!audioUrl) {
      return NextResponse.json({ error: "Ses URL bulunamadı." }, { status: 500 });
    }
    if (!animatedCoverUrl) {
      return NextResponse.json({ error: "Hareketli kapak URL bulunamadı." }, { status: 500 });
    }

    const audio = await downloadToTemp(audioUrl, "blerp-audio");
    cleanupPaths.push(audio.path);
    const cover = await downloadToTemp(animatedCoverUrl, "blerp-cover");
    cleanupPaths.push(cover.path);

    const audioInput = `${audio.path}${mediaExtFromType(audio.ctype) || ".bin"}`;
    const coverInput = `${cover.path}${mediaExtFromType(cover.ctype) || ".bin"}`;
    await fs.rename(audio.path, audioInput);
    await fs.rename(cover.path, coverInput);
    cleanupPaths.push(audioInput, coverInput);

    const outPath = join(tmpdir(), `blerp-video-${randomUUID()}.mp4`);
    cleanupPaths.push(outPath);

    const ffmpegArgs = [
      "-y",
      "-stream_loop",
      "-1",
      "-i",
      coverInput,
      "-i",
      audioInput,
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outPath,
    ];

    await execFileAsync(ffmpegBinary, ffmpegArgs);

    const outBuffer = await fs.readFile(outPath);
    return new NextResponse(new Uint8Array(outBuffer), {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="blerp_video.mp4"',
      },
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Video oluşturulamadı. Bu URL için hareketli kapak/ses erişimi engellenmiş olabilir." },
      { status: 500 }
    );
  } finally {
    await Promise.all(
      cleanupPaths.map(async (p) => {
        try {
          await fs.unlink(p);
        } catch {
          // ignore
        }
      })
    );
  }
}

