import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import fetchFn from "node-fetch";
import ffmpegPath from "ffmpeg-static";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const ffprobePath = require("ffprobe-static") as { path?: string };

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
  Referer: "https://blerp.com/",
};

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

function resolveFfprobePath(): string | null {
  const pathValue = ffprobePath.path;
  if (pathValue && existsSync(pathValue)) return pathValue;
  const candidates = [
    join(process.cwd(), "node_modules", "ffprobe-static", "bin", "darwin", "x64", "ffprobe"),
    join(process.cwd(), "node_modules", "ffprobe-static", "bin", "ffprobe"),
    join(process.cwd(), "node_modules", "ffprobe-static", "ffprobe"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
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

function audioExtFromType(contentType: string): string {
  const t = contentType.toLowerCase();
  if (t.includes("audio/mpeg") || t.includes("audio/mp3")) return ".mp3";
  if (t.includes("audio/ogg")) return ".ogg";
  if (t.includes("audio/wav")) return ".wav";
  return ".bin";
}

async function getAudioDurationSeconds(
  ffprobeBinary: string,
  audioPath: string
): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(ffprobeBinary, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    const n = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const cleanupPaths: string[] = [];
  try {
    const form = await req.formData();
    const url = (form.get("url") as string | null)?.trim();
    const gifFile = form.get("gif");

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "Geçerli bir URL gönder." }, { status: 400 });
    }
    if (!url.startsWith("https://blerp.com/soundbites/")) {
      return NextResponse.json(
        { error: "Sadece Blerp soundbites URL'leri destekleniyor." },
        { status: 400 }
      );
    }
    if (!gifFile || typeof gifFile === "string") {
      return NextResponse.json({ error: "GIF dosyası eksik." }, { status: 400 });
    }

    const ffmpegBinary = resolveFfmpegPath();
    if (!ffmpegBinary) {
      return NextResponse.json({ error: "FFmpeg bulunamadı." }, { status: 500 });
    }
    const ffprobeBinary = resolveFfprobePath();
    if (!ffprobeBinary) {
      return NextResponse.json({ error: "FFprobe bulunamadı." }, { status: 500 });
    }

    const pageResp = await fetchFn(url, { headers: HEADERS });
    if (!pageResp.ok) {
      return NextResponse.json(
        { error: "Sayfa alınamadı.", status: pageResp.status },
        { status: pageResp.status }
      );
    }
    const html = await pageResp.text();
    const audioUrl = await findAudioUrl(html);
    if (!audioUrl) {
      return NextResponse.json({ error: "Ses URL bulunamadı." }, { status: 500 });
    }

    const audioResp = await fetchFn(audioUrl, { headers: HEADERS, redirect: "follow" });
    if (!audioResp.ok) {
      return NextResponse.json(
        { error: "Ses indirilemedi.", status: audioResp.status },
        { status: audioResp.status }
      );
    }

    const audioType = audioResp.headers.get("content-type") || "application/octet-stream";
    const audioExt = audioExtFromType(audioType);

    const gifInputPath = join(tmpdir(), `cover-${randomUUID()}.gif`);
    const audioInputPath = join(tmpdir(), `audio-${randomUUID()}${audioExt}`);
    const outPath = join(tmpdir(), `video-${randomUUID()}.mp4`);
    cleanupPaths.push(gifInputPath, audioInputPath, outPath);

    const gifBuf = Buffer.from(await gifFile.arrayBuffer());
    await fs.writeFile(gifInputPath, gifBuf);
    const audioBuf = Buffer.from(await audioResp.arrayBuffer());
    await fs.writeFile(audioInputPath, audioBuf);
    const audioDuration = await getAudioDurationSeconds(ffprobeBinary, audioInputPath);

    const args = [
      "-y",
      "-stream_loop",
      "-1",
      "-i",
      gifInputPath,
      "-i",
      audioInputPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      ...(audioDuration ? ["-t", audioDuration.toFixed(3)] : []),
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outPath,
    ];
    await execFileAsync(ffmpegBinary, args);

    const out = await fs.readFile(outPath);
    return new NextResponse(new Uint8Array(out), {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="blerp_video.mp4"',
      },
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Video oluşturulamadı. Önce 1. adımda GIF hazırla, sonra tekrar dene." },
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

